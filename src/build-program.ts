import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  defaultVerifyRunner,
  describeAgent,
  resolveAgent,
  resolveRecoveryAgent,
  resolveValidatorAgent,
  runProcess,
  tail,
  type AgentRunner,
  type CommandResult,
  type VerifyRunner,
} from "./agent-runner.js";
import {
  resolveSummary,
  summaryContract,
  summaryEventData,
  summaryLine,
  type AgentSummary,
} from "./agent-summary.js";
import { criteriaGateFailure } from "./criteria.js";
import { inspectConvergenceReceipt } from "./convergence-receipt.js";
import {
  assessRepositoryExecutionFit,
  type ExecutionFitClassification,
} from "./execution-fit.js";
import type { Finding } from "./findings.js";
import { stableTopologicalOrder } from "./graph.js";
import {
  loadPipelineConfig,
  type AgentConfig,
  type PipelineConfig,
} from "./pipeline-config.js";
import { critiqueTests } from "./test-critique.js";
import { SPEC_CONTRACT, specSection, validateWorkstreams } from "./validate.js";

export {
  defaultAgentRunner,
  defaultVerifyRunner,
  sanitizedEnvironment,
  type AgentInvocation,
  type AgentRunner,
  type CommandResult,
  type VerifyRunner,
} from "./agent-runner.js";

export interface BuildProgramOptions {
  cwd: string;
  programId: string;
  startFrom?: string;
  dryRun?: boolean;
  approve?: boolean;
  /** Overrides `build.commit`; the CLI passes false for `--no-commit`. */
  commit?: boolean;
  agentRunner?: AgentRunner;
  verifyRunner?: VerifyRunner;
  now?: () => Date;
  /** Called with a human-readable line for each key build event. */
  onProgress?: (line: string) => void;
}

export interface PlanEntry {
  id: string;
  name: string;
  taskFile: string;
  action: "run" | "skip";
  reason?: string;
}

export interface WorkstreamOutcome {
  id: string;
  status: "complete" | "failed";
  attempts: number;
  agentExitCodes: number[];
  failedCommand?: string;
  /** Per-run log containing prompts, agent output, and verification failures. */
  logPath: string;
  executionFit: {
    classification: ExecutionFitClassification;
    workingSetTokens: number;
    lowerBoundTokens: number;
    upperBoundTokens: number;
  };
  /** Short SHA of the runner's commit for this workstream, when it committed. */
  commit?: string;
  /**
   * The agent's own account of its last attempt, verbatim. Present whether
   * the workstream passed or failed — on a failure it is usually the most
   * informative line in the whole run.
   */
  summary?: string;
}

export type BuildOutcome =
  | "COMPLETE"
  | "FAILED"
  | "ABORTED"
  | "PLANNED"
  | "APPROVAL_REQUIRED";

/**
 * A validator agent's opinion of the tests a workstream agent wrote. Advisory
 * by design: it never blocks a commit that passed independent verification.
 */
export interface TestCritiqueRecord {
  id: string;
  findings: Finding[];
  /** The validator's own account of the review, verbatim. */
  summary?: string;
}

export interface BuildProgramResult {
  programId: string;
  result: BuildOutcome;
  reason?: string;
  /** The resolved agent invocation (command and args), when configured. */
  agent?: string;
  /** Dedicated recovery invocation, when it differs from the build agent. */
  recoveryAgent?: string;
  plan: PlanEntry[];
  outcomes: WorkstreamOutcome[];
  /** Populated when `build.critiqueTests` is enabled. */
  testCritiques?: TestCritiqueRecord[];
  eventsPath?: string;
}

interface ManifestWorkstream {
  id: string;
  name: string;
  taskFile: string;
  status: string;
  dependencies: string[];
}

// A nonzero agent exit this soon after spawn, with the tree untouched, means
// the agent never got to work (usage limit, credentials, startup failure) —
// an environmental failure, not the workstream's.
const AGENT_ENVIRONMENT_FAILURE_MS = 30_000;

interface AgentOutputSignal {
  kind: "unverified" | "terminal";
  reason: string;
}

const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

function cleanOutput(output: string): string {
  return output.replace(ANSI_ESCAPE, "");
}

/**
 * Recognize provider-neutral failure statements printed by agent CLIs. Some
 * CLIs exit zero after recording an explicitly unverified submission; a zero
 * process status is not a successful implementation contract.
 */
export function classifyAgentOutput(output: string): AgentOutputSignal | undefined {
  // Agent CLIs may echo prompts and tool output. Terminal status belongs at
  // the end, so inspect only a bounded suffix to avoid matching quoted specs.
  const clean = tail(cleanOutput(output), 4_000);
  const terminalPatterns: Array<[RegExp, string]> = [
    [
      /maximum output token|(?:reached|exceeded).{0,40}(?:token|context).{0,20}limit|context window.{0,30}(?:exceeded|full)/i,
      "the agent reached its token or context limit",
    ],
    [
      /session limit|usage limit|rate limit|too many requests/i,
      "the agent provider reported a usage, session, or rate limit",
    ],
    [
      /invalid_payment_instrument|payment instrument|insufficient (?:credit|quota)/i,
      "the agent provider rejected the account's payment or quota",
    ],
    [
      /provided model identifier is invalid|model (?:identifier )?.{0,30}(?:invalid|not found|unsupported)/i,
      "the configured agent model is invalid or unavailable",
    ],
    [
      /authentication failed|unauthorized|invalid (?:api )?key|credentials? (?:missing|invalid|expired)/i,
      "the agent provider rejected or could not find its credentials",
    ],
  ];
  for (const [pattern, reason] of terminalPatterns) {
    if (pattern.test(clean)) return { kind: "terminal", reason };
  }
  if (
    /submission recorded\s*\(unverified\)/i.test(clean) ||
    /["']verified["']\s*:\s*false/i.test(clean)
  ) {
    return {
      kind: "unverified",
      reason: "the agent explicitly reported that its submission was unverified",
    };
  }
  return undefined;
}

function diagnosticLine(output: string): string | undefined {
  const lines = cleanOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic =
    lines.find((line) =>
      /(?:\berror\b|\bfailed\b|\bfailure\b|exception|cannot find|TS\d{4})/i.test(
        line,
      ),
    ) ?? lines[0];
  if (diagnostic === undefined) return undefined;
  return diagnostic.length > 240 ? `${diagnostic.slice(0, 237)}...` : diagnostic;
}

function verificationSignature(
  failures: Array<{ command: string; output: string }>,
): string {
  const normalized = failures
    .map(({ command, output }) =>
      `${command}\n${cleanOutput(output)}`
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/gi, "<duration>")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function sameAgent(left: AgentConfig, right: AgentConfig): boolean {
  return (
    left.command === right.command &&
    left.promptMode === right.promptMode &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fingerprint of the git working tree (status incl. all untracked files,
 * plus the uncommitted diff). Undefined when the root is not a git
 * repository or git is unavailable. Content edits inside files git does not
 * track are invisible to this signature; the declared-files check and
 * verification cover the remainder. The runner's own log directory is
 * excluded: the runner writes logs and baseline state there mid-build, and
 * those writes must never register as workstream changes.
 */
async function treeSignature(
  root: string,
  excludeDir?: string,
): Promise<string | undefined> {
  const pathspec = excludingLogDir(excludeDir);
  try {
    const status = await runProcess(
      "git",
      ["status", "--porcelain", "-uall", ...pathspec],
      { cwd: root, shell: false },
    );
    if (status.exitCode !== 0) return undefined;
    const diff = await runProcess("git", ["diff", "HEAD", ...pathspec], {
      cwd: root,
      shell: false,
    });
    return createHash("sha256")
      .update(`${status.output}\n${diff.exitCode === 0 ? diff.output : ""}`)
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Pathspec limiting a git command to the tree minus the runner's log dir. */
function excludingLogDir(excludeDir?: string): string[] {
  return excludeDir ? ["--", ".", `:(exclude)${excludeDir}`] : [];
}

/**
 * Working-tree entries in `git status --porcelain` form, excluding the
 * runner's own log directory. Empty when the tree is clean or git is
 * unavailable — callers gate on {@link treeSignature} for availability.
 */
async function dirtyPaths(root: string, excludeDir?: string): Promise<string[]> {
  try {
    const status = await runProcess(
      "git",
      ["status", "--porcelain", "-uall", ...excludingLogDir(excludeDir)],
      { cwd: root, shell: false },
    );
    if (status.exitCode !== 0) return [];
    return status.output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export interface CommitResult {
  /** Short SHA of the commit the runner created. */
  sha?: string;
  /** Set when there was nothing to commit. */
  empty?: boolean;
  /** Set when git refused the commit (hooks, identity, index state). */
  error?: string;
}

/**
 * Commit the working tree as the workstream's result. Called only after
 * independent verification passes, so every runner-authored commit is green.
 * The log directory is excluded: build logs are runner output, not work.
 */
async function commitWorkstream(
  root: string,
  excludeDir: string | undefined,
  message: string,
): Promise<CommitResult> {
  const pathspec = excludingLogDir(excludeDir);
  const git = (args: string[]): Promise<CommandResult> =>
    runProcess("git", args, { cwd: root, shell: false });
  try {
    // The log dir cannot be held out by pathspec here: `git add` fails
    // outright when any pathspec — a `:(exclude)` one included — names a
    // gitignored path, and a default project gitignores its log dir. Stage
    // the tree instead (git skips ignored files on its own), then unstage
    // the log dir, which restores its index entry from HEAD and so leaves
    // already-tracked log files as they were.
    const staged = await git(["add", "-A", "--", "."]);
    if (staged.exitCode !== 0) {
      return { error: `git add failed: ${tail(staged.output, 300).trim()}` };
    }
    if (excludeDir) {
      const held = await git(["reset", "--quiet", "--", excludeDir]);
      if (held.exitCode !== 0) {
        return { error: `git reset failed: ${tail(held.output, 300).trim()}` };
      }
    }
    // --quiet exits 0 when the index matches HEAD: nothing to commit.
    const pending = await git(["diff", "--cached", "--quiet", ...pathspec]);
    if (pending.exitCode === 0) return { empty: true };
    const committed = await git(["commit", "-m", message]);
    if (committed.exitCode !== 0) {
      return { error: `git commit failed: ${tail(committed.output, 300).trim()}` };
    }
    const head = await git(["rev-parse", "--short", "HEAD"]);
    return head.exitCode === 0 ? { sha: head.output.trim() } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function commitMessage(
  programId: string,
  workstream: ManifestWorkstream,
  verifyCommands: Record<string, string>,
): string {
  return `build(${programId}): ${workstream.id} ${workstream.name}

Workstream spec: ${workstream.taskFile}
Verified: ${Object.keys(verifyCommands).join(", ")}
`;
}

/** Paths annotated (NEW) in the spec's Files Touched section. */
function declaredNewFiles(specMarkdown: string): string[] {
  const filesTouched = specSection(
    specMarkdown,
    SPEC_CONTRACT.sections.filesTouched,
  );
  if (!filesTouched) return [];
  const fileEntry = new RegExp(SPEC_CONTRACT.fileEntryPattern, "u");
  const newAnnotation = new RegExp(SPEC_CONTRACT.newFileAnnotationPattern, "u");
  const files: string[] = [];
  for (const line of filesTouched.split(/\r?\n/u)) {
    if (!fileEntry.test(line) || !newAnnotation.test(line)) continue;
    const path = line.match(/`([^`]+)`/u)?.[1];
    if (path) files.push(path);
  }
  return files;
}

function workstreamPrompt(
  workstream: ManifestWorkstream,
  verifyCommands: Record<string, string>,
): string {
  const verification = Object.entries(verifyCommands)
    .map(([name, command]) => `- ${name}: \`${command}\``)
    .join("\n");
  return `You are implementing workstream '${workstream.id}: ${workstream.name}'.

STEP 1 - CONTEXT:
- Read the workstream spec: ${workstream.taskFile}
- Read AGENTS.md for agent directives and coding conventions.
- Read every additional file listed in the spec's "Context Files" section.

STEP 2 - IMPLEMENT:
- Implement every requirement and every file listed in "Files Touched".
- Follow the spec's implementation steps.
- Write the tests described by the spec.
- Do not commit changes, bypass hooks, or weaken verification. The build runner
  commits your work itself once it passes independent verification; leave the
  changes in the working tree.

STEP 3 - VERIFY (mandatory):
These exact commands are re-run independently after you finish; the workstream
fails unless every one of them exits successfully:
${verification}
- Run every command above against the final working tree. A successful build or
  targeted test does not substitute for the complete command list.
- Fix all failures caused by this workstream or by program changes it depends on,
  including failures in tests, fixtures, imports, types, and lint rules. Those
  failures are part of the implementation, not "out of scope."
- If a command fails, continue working and repeat the complete verification list.
  Do not report completion or submit while any command is failing.

RULES:
- Create files marked (NEW); edit existing files marked (MODIFY).
- Replace any prior-workstream stub with the complete implementation.
- Stop and report a blocker rather than silently skipping a requirement.

${summaryContract()}
`;
}

function recoveryPrompt(
  workstream: ManifestWorkstream,
  failureReason: string,
  failureOutput: string,
  verifyCommands: Record<string, string>,
): string {
  const verification = Object.entries(verifyCommands)
    .map(([name, command]) => `- ${name}: \`${command}\``)
    .join("\n");
  return `Workstream '${workstream.id}: ${workstream.name}' failed its previous build attempt.

- Read the workstream spec: ${workstream.taskFile}
- ${failureReason}
- Output tail:
${tail(failureOutput)}

- Fix the implementation and tests required by this workstream. Failures in
  tests, fixtures, imports, types, and lint rules caused by this workstream or
  prior program changes it depends on are in scope and must not be dismissed.
- Run every command below against the final working tree:
${verification}
- A successful build or targeted test does not substitute for this complete
  list. If any command fails, continue fixing and rerun the complete list.
- Do not report completion or submit while any verification command is failing.
- Do not commit changes, bypass hooks, or weaken verification. The build runner
  commits your work itself once it passes independent verification; leave the
  changes in the working tree.

${summaryContract()}
`;
}

async function writeWorkstreamStatus(
  manifestPath: string,
  workstreamId: string,
  status: string,
): Promise<void> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    workstreams: Array<{ id: string; status: string }>;
  };
  const entry = raw.workstreams.find(({ id }) => id === workstreamId);
  if (entry) entry.status = status;
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function everyWorkstreamComplete(manifestPath: string): Promise<boolean> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    workstreams: Array<{ status: string }>;
  };
  return raw.workstreams.every(({ status }) => status === "complete");
}

async function writeProgramStatus(
  manifestPath: string,
  status: "in_progress" | "complete" | "failed",
): Promise<void> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    program?: { status?: string };
  };
  if (raw.program) raw.program.status = status;
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function buildPlan(
  ordered: ManifestWorkstream[],
  startFrom: string | undefined,
): { plan: PlanEntry[]; error?: string } {
  if (startFrom) {
    const matches = ordered.filter(({ id }) =>
      id.toLowerCase().startsWith(startFrom.toLowerCase()),
    );
    if (matches.length === 0) {
      return { plan: [], error: `No workstream ID starts with '${startFrom}'.` };
    }
    if (matches.length > 1) {
      return {
        plan: [],
        error: `Workstream prefix '${startFrom}' is ambiguous: ${matches
          .map(({ id }) => id)
          .join(", ")}.`,
      };
    }
    const startIndex = ordered.findIndex(({ id }) => id === matches[0]?.id);
    const plan: PlanEntry[] = ordered.map((workstream, index) =>
      index < startIndex
        ? {
            id: workstream.id,
            name: workstream.name,
            taskFile: workstream.taskFile,
            action: "skip",
            reason: "before start point",
          }
        : {
            id: workstream.id,
            name: workstream.name,
            taskFile: workstream.taskFile,
            action: "run",
          },
    );

    // A skipped workstream may only satisfy a dependency of the run set when
    // it has actually been completed.
    const byId = new Map(ordered.map((workstream) => [workstream.id, workstream]));
    const runIds = new Set(
      plan.filter(({ action }) => action === "run").map(({ id }) => id),
    );
    const required = new Set<string>();
    const pending = [...runIds];
    while (pending.length > 0) {
      const current = byId.get(pending.pop() as string);
      for (const dependency of current?.dependencies ?? []) {
        if (byId.has(dependency) && !required.has(dependency)) {
          required.add(dependency);
          pending.push(dependency);
        }
      }
    }
    const unmet = [...required].filter(
      (id) => !runIds.has(id) && byId.get(id)?.status !== "complete",
    );
    if (unmet.length > 0) {
      return {
        plan: [],
        error: `Cannot start from '${startFrom}': skipped dependencies are not complete: ${unmet.join(", ")}.`,
      };
    }
    return { plan };
  }

  return {
    plan: ordered.map((workstream) =>
      workstream.status === "complete"
        ? {
            id: workstream.id,
            name: workstream.name,
            taskFile: workstream.taskFile,
            action: "skip",
            reason: "already complete",
          }
        : {
            id: workstream.id,
            name: workstream.name,
            taskFile: workstream.taskFile,
            action: "run",
          },
    ),
  };
}

export async function buildProgram(
  options: BuildProgramOptions,
): Promise<BuildProgramResult> {
  const root = resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const agentRunner = options.agentRunner ?? defaultAgentRunner;
  const verifyRunner = options.verifyRunner ?? defaultVerifyRunner;
  const progress = options.onProgress ?? ((): void => {});
  const minutesSince = (startMs: number): string =>
    `${((now().getTime() - startMs) / 60_000).toFixed(1)}m`;

  const aborted = (reason: string, plan: PlanEntry[] = []): BuildProgramResult => ({
    programId: options.programId,
    result: "ABORTED",
    reason,
    plan,
    outcomes: [],
  });

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }

  const preflight = await validateWorkstreams(root, options.programId);
  if (preflight.result === "FAILED") {
    const blockers = preflight.findings
      .filter(({ severity }) => severity === "blocker")
      .map(({ code, message }) => `${code}: ${message}`);
    return aborted(
      `Preflight validation failed with ${blockers.length} blocker(s): ${blockers.join(" | ")}`,
    );
  }

  const manifestPath = join(
    root,
    "docs",
    "programs",
    `${options.programId}-manifest.json`,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    workstreams: ManifestWorkstream[];
  };

  let ordered: ManifestWorkstream[];
  try {
    ordered = stableTopologicalOrder(manifest.workstreams);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }

  const { plan, error: planError } = buildPlan(ordered, options.startFrom);
  if (planError) return aborted(planError);

  const agent = resolveAgent(config);
  const agentLabel = agent ? describeAgent(agent) : undefined;
  const recovery = resolveRecoveryAgent(config);
  const distinctRecovery =
    agent !== undefined &&
    recovery !== undefined &&
    !sameAgent(agent, recovery.agent)
      ? recovery.agent
      : undefined;
  const recoveryLabel = distinctRecovery
    ? describeAgent(distinctRecovery)
    : undefined;
  const agentField = {
    ...(agentLabel === undefined ? {} : { agent: agentLabel }),
    ...(recoveryLabel === undefined ? {} : { recoveryAgent: recoveryLabel }),
  };

  if (options.dryRun) {
    return {
      programId: options.programId,
      result: "PLANNED",
      ...agentField,
      plan,
      outcomes: [],
    };
  }

  // The acceptance-criteria gate is about *what* is being built, so it comes
  // before the gate about whether to proceed now.
  if (config.build.requireCriteriaApproval) {
    const failure = await criteriaGateFailure(root, options.programId);
    if (failure) return aborted(failure, plan);
  }

  if (config.requireApprovalBeforeBuild && !options.approve) {
    return {
      programId: options.programId,
      result: "APPROVAL_REQUIRED",
      reason:
        "pipeline.config.json sets requireApprovalBeforeBuild; re-run with --yes to execute this plan.",
      ...agentField,
      plan,
      outcomes: [],
    };
  }

  let convergence;
  try {
    convergence = await inspectConvergenceReceipt(
      root,
      options.programId,
      config,
    );
  } catch (error) {
    return aborted(
      `Could not verify semantic convergence inputs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      plan,
    );
  }
  if (!convergence.valid) {
    return aborted(
      `Semantic convergence receipt is ${convergence.reason ?? "invalid"} for ${options.programId}; the specifications or their planning context have not passed the current convergence gate. Run program-pipeline converge ${options.programId}, or use program-pipeline run ${options.programId} --from build to refresh it automatically.`,
      plan,
    );
  }

  const verifyCommands = config.verify;
  if (Object.keys(verifyCommands).length === 0) {
    return aborted(
      'No verification commands configured; add a "verify" block to pipeline.config.json (for example {"build": "npm run build", "test": "npm test"}).',
      plan,
    );
  }

  if (!agent) {
    return aborted(
      'No agent configured; add an "agent" block to pipeline.config.json or set PROGRAM_PIPELINE_AGENT_COMMAND.',
      plan,
    );
  }

  const executionFitById = new Map<
    string,
    WorkstreamOutcome["executionFit"]
  >();
  for (const entry of plan) {
    if (entry.action !== "run") continue;
    let assessment;
    try {
      assessment = await assessRepositoryExecutionFit(
        {
          root,
          taskPath: entry.taskFile,
          visionPath: config.visionPath,
          contextDocs: config.contextDocs,
        },
        config.build.executionProfile,
      );
    } catch (error) {
      return aborted(
        `Could not estimate execution fit for ${entry.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        plan,
      );
    }
    const fit = {
      classification: assessment.classification,
      workingSetTokens: assessment.workingSetTokens,
      lowerBoundTokens: assessment.lowerBoundTokens,
      upperBoundTokens: assessment.upperBoundTokens,
    };
    executionFitById.set(entry.id, fit);
    if (assessment.hardFailure) {
      return aborted(
        `${entry.id} cannot fit the configured ${config.build.executionProfile.contextWindowTokens}-token context window even at the estimate's lower bound (${assessment.lowerBoundTokens} tokens). Split the workstream or configure an execution profile matching the actual agent capacity.`,
        plan,
      );
    }
    if (assessment.classification !== "normal") {
      progress(
        `${entry.id} execution fit: ${assessment.classification} at approximately ${assessment.workingSetTokens} tokens (${assessment.lowerBoundTokens}-${assessment.upperBoundTokens}); proceeding because only physical impossibility is a hard gate`,
      );
    }
  }

  const logDir = join(root, config.build.logDir);
  await mkdir(logDir, { recursive: true });
  const stamp = `${now()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z")}-${randomUUID().slice(0, 8)}`;
  const eventsPath = join(logDir, `${options.programId}-build-${stamp}.jsonl`);
  const emit = async (
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<void> => {
    await appendFile(
      eventsPath,
      `${JSON.stringify({ timestamp: now().toISOString(), event, ...data })}\n`,
      "utf8",
    );
  };

  const signTree = (): Promise<string | undefined> =>
    treeSignature(root, config.build.logDir);
  const treeGuardAvailable = (await signTree()) !== undefined;

  // The runner owns commits: one per workstream, written only after that
  // workstream passes independent verification.
  const commitRequested = options.commit ?? config.build.commit;
  const commitEnabled = commitRequested && treeGuardAvailable;

  // Signature of the working tree a previous failed run of this program left
  // behind. It is the only uncommitted state the runner will build on top of
  // — anything else is the user's own work and must not land in a
  // machine-authored commit.
  const uncommittedPath = join(logDir, `${options.programId}-uncommitted.json`);
  const readLeftoverSignature = async (): Promise<string | undefined> => {
    try {
      const state = JSON.parse(await readFile(uncommittedPath, "utf8")) as {
        signature?: string;
      };
      return state.signature;
    } catch {
      return undefined;
    }
  };
  const recordLeftovers = async (workstreamId: string): Promise<void> => {
    if (!commitEnabled) return;
    const signature = await signTree();
    if (signature === undefined) return;
    await writeFile(
      uncommittedPath,
      `${JSON.stringify(
        { signature, workstreamId, timestamp: now().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  if (commitEnabled) {
    const dirty = await dirtyPaths(root, config.build.logDir);
    if (dirty.length > 0) {
      const leftover = await readLeftoverSignature();
      if (leftover === undefined || leftover !== (await signTree())) {
        return aborted(
          `The working tree has ${dirty.length} uncommitted change(s), and the runner commits each workstream itself — it will not sweep unrelated work into a build commit. Commit or stash your changes and re-run, or re-run with --no-commit to build without committing. Changes: ${dirty
            .slice(0, 10)
            .join("; ")}${dirty.length > 10 ? "; …" : ""}`,
          plan,
        );
      }
      progress(
        `resuming on top of ${dirty.length} uncommitted change(s) left by a previous failed build`,
      );
    }
  }

  await emit("build-start", {
    programId: options.programId,
    plan,
    agentCommand: agent.command,
    verify: Object.keys(verifyCommands),
    commit: commitEnabled,
  });
  await writeProgramStatus(manifestPath, "in_progress");

  if (commitRequested && !commitEnabled) {
    await emit("commit-disabled", {
      reason: "not a git repository or git unavailable",
    });
    progress("per-workstream commits disabled: not a git repository");
  }

  // Tree signatures captured before each workstream's first-ever attempt,
  // persisted across runs. They let the no-op guard distinguish an agent
  // that did nothing from one that found prior attempts' work already in
  // place — without this, a workstream whose implementation landed in an
  // earlier run can never pass a re-run (every honest agent no-ops).
  const baselinesPath = join(logDir, `${options.programId}-baselines.json`);
  let originalBaselines: Record<string, string> = {};
  try {
    originalBaselines = JSON.parse(await readFile(baselinesPath, "utf8")) as Record<
      string,
      string
    >;
  } catch {
    // First build for this program, or the state file was removed.
  }

  if (!treeGuardAvailable) {
    await emit("tree-guard-disabled", {
      reason:
        "not a git repository or git unavailable; no-op detection limited to declared (NEW) files",
    });
    progress("no-op tree guard disabled: not a git repository");
  }

  const buildStartMs = now().getTime();
  const runTotal = plan.filter(({ action }) => action === "run").length;
  progress(
    `build ${options.programId}: ${runTotal} workstream(s) to run, agent: ${agentLabel ?? agent.command}`,
  );

  const outcomes: WorkstreamOutcome[] = [];
  const testCritiques: TestCritiqueRecord[] = [];
  const byId = new Map(ordered.map((workstream) => [workstream.id, workstream]));
  let runIndex = 0;

  for (const entry of plan) {
    if (entry.action === "skip") {
      await emit("workstream-skipped", { id: entry.id, reason: entry.reason });
      progress(`${entry.id} skipped (${entry.reason ?? "skipped"})`);
      continue;
    }
    runIndex += 1;
    const workstream = byId.get(entry.id) as ManifestWorkstream;
    const executionFit = executionFitById.get(workstream.id) as WorkstreamOutcome["executionFit"];
    const workstreamLog = join(
      logDir,
      `${options.programId}-build-${stamp}-${workstream.id}.log`,
    );
    const logStream = createWriteStream(workstreamLog, { flags: "w" });
    const agentExitCodes: number[] = [];
    let attempts = 0;
    let failedCommand: string | undefined;
    let failureReason = "";
    let failureOutput = "";
    let verified = false;
    let lastSummary: AgentSummary | undefined;
    let previousVerificationSignature: string | undefined;

    await writeWorkstreamStatus(manifestPath, workstream.id, "in_progress");
    await emit("workstream-start", {
      id: workstream.id,
      name: workstream.name,
      logPath: workstreamLog,
      executionFit,
    });
    if (treeGuardAvailable && originalBaselines[workstream.id] === undefined) {
      const original = await signTree();
      if (original !== undefined) {
        originalBaselines[workstream.id] = original;
        await writeFile(
          baselinesPath,
          `${JSON.stringify(originalBaselines, null, 2)}\n`,
          "utf8",
        );
      }
    }
    const workstreamStartMs = now().getTime();
    progress(
      `${workstream.id} start: ${workstream.name} (${runIndex}/${runTotal})`,
    );

    let newFiles: string[] = [];
    let specMarkdown = "";
    try {
      specMarkdown = await readFile(resolve(root, workstream.taskFile), "utf8");
      newFiles = declaredNewFiles(specMarkdown);
    } catch {
      // Preflight validation already guarantees the spec exists.
    }

    try {
      const maxAttempts = 1 + config.build.maxRecoveryAttempts;
      while (attempts < maxAttempts && !verified) {
        attempts += 1;
        const attemptAgent =
          attempts === 1 ? agent : (recovery?.agent ?? agent);
        const attemptAgentLabel = describeAgent(attemptAgent);
        const prompt =
          attempts === 1
            ? workstreamPrompt(workstream, verifyCommands)
            : recoveryPrompt(
                workstream,
                failureReason,
                failureOutput,
                verifyCommands,
              );
        const baseline = treeGuardAvailable ? await signTree() : undefined;

        logStream.write(
          `=== attempt ${attempts} (${now().toISOString()}) ===\n--- agent ---\n${attemptAgentLabel}\n--- prompt ---\n${prompt}\n--- agent output ---\n`,
        );
        await emit("agent-start", {
          id: workstream.id,
          attempt: attempts,
          agent: attemptAgentLabel,
          promptBytes: Buffer.byteLength(prompt, "utf8"),
        });
        const attemptStartMs = now().getTime();
        progress(`${workstream.id} attempt ${attempts}/${maxAttempts}: agent running`);
        let agentResult: CommandResult;
        try {
          agentResult = await agentRunner({
            command: attemptAgent.command,
            args: attemptAgent.args,
            prompt,
            promptMode: attemptAgent.promptMode,
            cwd: root,
            onOutput: (chunk) => logStream.write(chunk),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emit("agent-error", { id: workstream.id, attempt: attempts, message });
          progress(`${workstream.id} agent failed to start: ${message}`);
          await writeWorkstreamStatus(manifestPath, workstream.id, "failed");
          await writeProgramStatus(manifestPath, "failed");
          await recordLeftovers(workstream.id);
          outcomes.push({
            id: workstream.id,
            status: "failed",
            attempts,
            agentExitCodes,
            logPath: workstreamLog,
            executionFit,
          });
          return {
            programId: options.programId,
            result: "FAILED",
          reason: `Agent command ${attemptAgentLabel} failed to start for ${workstream.id}: ${message}`,
            ...agentField,
            plan,
            outcomes,
            eventsPath,
          };
        }

        agentExitCodes.push(agentResult.exitCode);
        await emit("agent-exit", {
          id: workstream.id,
          attempt: attempts,
          agent: attemptAgentLabel,
          exitCode: agentResult.exitCode,
          ...(agentResult.inputError
            ? { inputError: agentResult.inputError }
            : {}),
        });
        progress(
          `${workstream.id} agent exited ${agentResult.exitCode} after ${minutesSince(attemptStartMs)}`,
        );

        // Emitted before any pass/fail branching, so the agent's own account
        // survives every path out of the attempt — a crash, a no-op, and a
        // failed verify all keep it.
        lastSummary = resolveSummary(agentResult.output);
        await emit("agent-summary", {
          id: workstream.id,
          attempt: attempts,
          ...summaryEventData("build", prompt, lastSummary),
        });
        progress(`${workstream.id} summary: ${summaryLine(lastSummary)}`);

        // A failed prompt delivery fails the attempt regardless of exit code:
        // an agent that never received instructions can exit 0 against an
        // already-green repo and would otherwise be falsely completed.
        if (agentResult.inputError) {
          verified = false;
          failedCommand = undefined;
          failureReason = `The prompt could not be delivered to the agent's stdin (${agentResult.inputError}); the agent likely ran without instructions.`;
          failureOutput = agentResult.output;
          previousVerificationSignature = undefined;
          logStream.write(
            `=== prompt delivery failed: ${agentResult.inputError} ===\n`,
          );
          progress(
            `${workstream.id} prompt delivery failed (${agentResult.inputError})`,
          );
          continue;
        }

        const outputSignal = classifyAgentOutput(agentResult.output);
        if (outputSignal?.kind === "terminal") {
          const canSwitchToRecovery =
            attempts === 1 && distinctRecovery !== undefined && attempts < maxAttempts;
          verified = false;
          failedCommand = undefined;
          failureReason = canSwitchToRecovery
            ? `The primary agent could not complete the workstream because ${outputSignal.reason}; continue with the configured recovery agent.`
            : `Agent environment failure or capacity failure: ${outputSignal.reason}; retrying the same invocation cannot complete this workstream.`;
          failureOutput = agentResult.output;
          await emit("agent-terminal-signal", {
            id: workstream.id,
            attempt: attempts,
            agent: attemptAgentLabel,
            reason: outputSignal.reason,
          });
          logStream.write(
            `=== terminal agent signal: ${outputSignal.reason} ===\n`,
          );
          if (canSwitchToRecovery) {
            progress(
              `${workstream.id} primary agent stopped: ${outputSignal.reason}; switching to recovery agent ${recoveryLabel}`,
            );
            continue;
          }
          progress(
            `${workstream.id} agent stopped: ${outputSignal.reason}; build stopped`,
          );
          break;
        }
        if (outputSignal?.kind === "unverified") {
          verified = false;
          failedCommand = undefined;
          failureReason = `${outputSignal.reason}; independent verification was not run.`;
          failureOutput = agentResult.output;
          previousVerificationSignature = undefined;
          await emit("agent-unverified", {
            id: workstream.id,
            attempt: attempts,
            reason: outputSignal.reason,
          });
          logStream.write(
            `=== agent explicitly unverified: ${outputSignal.reason} ===\n`,
          );
          progress(`${workstream.id} agent outcome: unverified; recovering`);
          continue;
        }

        // A nonzero agent exit fails the attempt outright; verification alone
        // must never rubber-stamp a workstream the agent did not finish.
        if (agentResult.exitCode !== 0) {
          const environmental =
            baseline !== undefined &&
            now().getTime() - attemptStartMs < AGENT_ENVIRONMENT_FAILURE_MS &&
            (await signTree()) === baseline;
          if (environmental) {
            await emit("agent-environment-failure", {
              id: workstream.id,
              attempt: attempts,
              exitCode: agentResult.exitCode,
            });
            logStream.write(
              `=== agent environment failure: exit ${agentResult.exitCode} with no changes ===\n`,
            );
            progress(
              `${workstream.id} agent environment failure: exited ${agentResult.exitCode} in ${minutesSince(attemptStartMs)} with no changes; build stopped`,
            );
            await writeWorkstreamStatus(manifestPath, workstream.id, "failed");
            await writeProgramStatus(manifestPath, "failed");
            await recordLeftovers(workstream.id);
            outcomes.push({
              id: workstream.id,
              status: "failed",
              attempts,
              agentExitCodes,
              logPath: workstreamLog,
              executionFit,
              ...(lastSummary === undefined ? {} : { summary: lastSummary.text }),
            });
            await emit("build-failed", { id: workstream.id });
            return {
              programId: options.programId,
              result: "FAILED",
              reason: `Agent environment failure for ${workstream.id}: the agent exited ${agentResult.exitCode} almost immediately without touching the working tree (likely a rate/usage limit, credential, or startup problem — not a workstream defect). Re-run the build to resume once the agent CLI is healthy. Output tail: ${tail(agentResult.output, 300).trim()}`,
              ...agentField,
              plan,
              outcomes,
              eventsPath,
            };
          }
          verified = false;
          failedCommand = undefined;
          failureReason = `The agent process exited with code ${agentResult.exitCode} before completing the workstream.`;
          failureOutput = agentResult.output;
          previousVerificationSignature = undefined;
          logStream.write(
            `=== agent exited with code ${agentResult.exitCode} ===\n`,
          );
          continue;
        }

        // No-op guards: an agent that exits cleanly without implementing
        // anything must never reach verification, because verification of an
        // already-green repo would falsely complete the workstream.
        if (baseline !== undefined) {
          const after = await signTree();
          if (after === baseline) {
            const original = originalBaselines[workstream.id];
            if (original !== undefined && after !== original) {
              // The tree already differs from how it stood before this
              // workstream's first attempt: earlier attempts left work in
              // place, so an agent that changes nothing is reporting
              // "already implemented", not idling. Let verification decide.
              await emit("no-op-accepted", {
                id: workstream.id,
                attempt: attempts,
                kind: "prior-work-present",
              });
              logStream.write(
                "=== no-op accepted: prior work present, verifying ===\n",
              );
              progress(
                `${workstream.id} no-op with prior work present: verifying`,
              );
            } else {
              verified = false;
              failedCommand = undefined;
              failureReason =
                "The agent exited successfully but made no changes to the working tree, and no prior attempt changed it either; the workstream was not implemented.";
              failureOutput = agentResult.output;
              previousVerificationSignature = undefined;
              await emit("no-op", {
                id: workstream.id,
                attempt: attempts,
                kind: "tree-unchanged",
              });
              logStream.write("=== no-op: working tree unchanged ===\n");
              progress(`${workstream.id} no-op: working tree unchanged`);
              continue;
            }
          }
        }

        const missingNew: string[] = [];
        for (const file of newFiles) {
          if (!(await pathExists(resolve(root, file)))) missingNew.push(file);
        }
        if (missingNew.length > 0) {
          verified = false;
          failedCommand = undefined;
          failureReason = `The spec declares (NEW) files that do not exist after the attempt: ${missingNew.join(", ")}.`;
          failureOutput = agentResult.output;
          previousVerificationSignature = undefined;
          await emit("no-op", {
            id: workstream.id,
            attempt: attempts,
            kind: "missing-new-files",
            missing: missingNew,
          });
          logStream.write(
            `=== declared (NEW) files missing: ${missingNew.join(", ")} ===\n`,
          );
          progress(
            `${workstream.id} no-op: missing (NEW) files: ${missingNew.join(", ")}`,
          );
          continue;
        }

        failedCommand = undefined;
        failureOutput = "";
        verified = true;
        const verificationFailures: Array<{
          command: string;
          output: string;
        }> = [];
        for (const [name, command] of Object.entries(verifyCommands)) {
          // A failure that vanishes on an immediate re-run is a flaky verify
          // command, not a workstream defect — retry before spending a
          // recovery agent on it.
          const maxRuns = 1 + config.build.verifyRetries;
          let verifyResult: CommandResult = { exitCode: 1, output: "" };
          for (let run = 1; run <= maxRuns; run += 1) {
            await emit("verify-start", {
              id: workstream.id,
              attempt: attempts,
              name,
              run,
            });
            verifyResult = await verifyRunner(command, root);
            await emit("verify-result", {
              id: workstream.id,
              attempt: attempts,
              name,
              command,
              exitCode: verifyResult.exitCode,
              run,
            });
            if (verifyResult.exitCode === 0) break;
            if (run < maxRuns) {
              progress(
                `${workstream.id} verify ${name}: failed, retrying (${run}/${config.build.verifyRetries})`,
              );
            }
          }
          if (verifyResult.exitCode !== 0) {
            verified = false;
            verificationFailures.push({
              command,
              output: verifyResult.output,
            });
            logStream.write(
              `=== verification failed: ${command} ===\n${verifyResult.output}\n`,
            );
            const diagnostic = diagnosticLine(verifyResult.output);
            progress(
              `${workstream.id} verify ${name}: FAILED (${command})${
                diagnostic === undefined ? "" : ` — ${diagnostic}`
              }`,
            );
          } else {
            progress(`${workstream.id} verify ${name}: ok`);
          }
        }
        if (verificationFailures.length > 0) {
          failedCommand = verificationFailures[0]?.command;
          const firstDiagnostic = verificationFailures
            .map(({ output }) => diagnosticLine(output))
            .find((line) => line !== undefined);
          failureReason = `It failed independent verification; the failing commands were:\n${verificationFailures
            .map(({ command }) => `  - ${command}`)
            .join("\n")}${
            firstDiagnostic === undefined
              ? ""
              : `\nFirst diagnostic: ${firstDiagnostic}`
          }`;
          failureOutput = verificationFailures
            .map(
              ({ command, output }) =>
                `=== ${command} ===\n${tail(output)}`,
            )
            .join("\n\n");
          const signature = verificationSignature(verificationFailures);
          if (signature === previousVerificationSignature) {
            const diagnostic = diagnosticLine(failureOutput);
            failureReason = `Independent verification failed identically on two consecutive attempts; further blind recovery was stopped.${
              diagnostic === undefined ? "" : ` First diagnostic: ${diagnostic}`
            }`;
            await emit("recovery-circuit-break", {
              id: workstream.id,
              attempt: attempts,
              signature,
              commands: verificationFailures.map(({ command }) => command),
            });
            logStream.write(
              "=== recovery circuit break: identical verification failure ===\n",
            );
            progress(
              `${workstream.id} recovery stopped: verification failed identically twice`,
            );
            break;
          }
          previousVerificationSignature = signature;
        }
      }
    } finally {
      await new Promise<void>((resolveStream) => logStream.end(resolveStream));
    }

    if (verified) {
      // Independent verification only proves the implementation and its tests
      // agree — the same agent wrote both. Ask the validator agent whether the
      // tests would catch a wrong implementation. This annotates the build; it
      // never blocks a commit that already passed verification.
      if (config.build.critiqueTests) {
        const critique = await critiqueTests({
          root,
          workstreamId: workstream.id,
          workstreamName: workstream.name,
          spec: specMarkdown,
          validator: resolveValidatorAgent(config),
          agentRunner,
        });
        if (critique.skipped) {
          await emit("test-critique-skipped", {
            id: workstream.id,
            reason: critique.skipped,
          });
          progress(`${workstream.id} test critique skipped: ${critique.skipped}`);
        } else {
          testCritiques.push({
            id: workstream.id,
            findings: critique.findings,
            ...(critique.summary === undefined
              ? {}
              : { summary: critique.summary }),
          });
          await emit("test-critique", {
            id: workstream.id,
            findings: critique.findings,
            ...(critique.summary === undefined
              ? {}
              : { summary: critique.summary }),
          });
          progress(
            critique.findings.length === 0
              ? `${workstream.id} test critique: no findings`
              : `${workstream.id} test critique: ${critique.findings.length} finding(s)`,
          );
        }
      }

      // Manifest statuses are written before the commit so the workstream's
      // completion — and, for the last one, the program's — travel in the
      // commit that carries the implementation, leaving the tree clean.
      await writeWorkstreamStatus(manifestPath, workstream.id, "complete");
      if (await everyWorkstreamComplete(manifestPath)) {
        await writeProgramStatus(manifestPath, "complete");
      }
      let commitSha: string | undefined;
      if (commitEnabled) {
        const committed = await commitWorkstream(
          root,
          config.build.logDir,
          commitMessage(options.programId, workstream, verifyCommands),
        );
        if (committed.error) {
          // The work is verified and the manifest is updated; a git-side
          // refusal (hooks, missing identity) is not a workstream failure.
          await emit("commit-failed", {
            id: workstream.id,
            message: committed.error,
          });
          progress(
            `${workstream.id} commit failed, changes left in the working tree: ${committed.error}`,
          );
        } else if (committed.empty) {
          await emit("commit-skipped", {
            id: workstream.id,
            reason: "nothing to commit",
          });
          progress(`${workstream.id} nothing to commit`);
        } else {
          commitSha = committed.sha;
          await rm(uncommittedPath, { force: true });
          await emit("commit", { id: workstream.id, sha: commitSha });
          progress(`${workstream.id} committed ${commitSha ?? ""}`.trimEnd());
        }
      }
      await emit("workstream-complete", { id: workstream.id, attempts });
      progress(
        `${workstream.id} complete after ${attempts} attempt(s) in ${minutesSince(workstreamStartMs)}`,
      );
      outcomes.push({
        id: workstream.id,
        status: "complete",
        attempts,
        agentExitCodes,
        logPath: workstreamLog,
        executionFit,
        ...(commitSha === undefined ? {} : { commit: commitSha }),
        ...(lastSummary === undefined ? {} : { summary: lastSummary.text }),
      });
    } else {
      await writeWorkstreamStatus(manifestPath, workstream.id, "failed");
      await writeProgramStatus(manifestPath, "failed");
      await recordLeftovers(workstream.id);
      await emit("workstream-failed", {
        id: workstream.id,
        attempts,
        failedCommand,
      });
      outcomes.push({
        id: workstream.id,
        status: "failed",
        attempts,
        agentExitCodes,
        logPath: workstreamLog,
        executionFit,
        ...(failedCommand === undefined ? {} : { failedCommand }),
        ...(lastSummary === undefined ? {} : { summary: lastSummary.text }),
      });
      await emit("build-failed", { id: workstream.id });
      progress(
        `${workstream.id} FAILED after ${attempts} attempt(s) in ${minutesSince(workstreamStartMs)}; build stopped`,
      );
      const finalDiagnostic = diagnosticLine(failureOutput);
      return {
        programId: options.programId,
        result: "FAILED",
        reason: `Workstream ${workstream.id} failed after ${attempts} attempt(s). ${failureReason || "The workstream did not pass independent verification."}${
          finalDiagnostic === undefined || failureReason.includes(finalDiagnostic)
            ? ""
            : ` Diagnostic: ${finalDiagnostic}`
        } See ${workstreamLog}.`,
        ...agentField,
        plan,
        outcomes,
        ...(testCritiques.length > 0 ? { testCritiques } : {}),
        eventsPath,
      };
    }
  }

  await writeProgramStatus(manifestPath, "complete");
  await emit("build-complete", {
    programId: options.programId,
    workstreams: outcomes.length,
  });
  progress(
    `build ${options.programId} complete: ${outcomes.length} workstream(s) in ${minutesSince(buildStartMs)}`,
  );
  return {
    programId: options.programId,
    result: "COMPLETE",
    ...agentField,
    plan,
    outcomes,
    ...(testCritiques.length > 0 ? { testCritiques } : {}),
    eventsPath,
  };
}
