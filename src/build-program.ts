import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableTopologicalOrder } from "./graph.js";
import {
  loadPipelineConfig,
  type AgentConfig,
  type PipelineConfig,
} from "./pipeline-config.js";
import { SPEC_CONTRACT, specSection, validateWorkstreams } from "./validate.js";

export interface CommandResult {
  exitCode: number;
  output: string;
  /** Set when the prompt could not be fully delivered to the process stdin. */
  inputError?: string;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  prompt: string;
  promptMode: "stdin" | "argument";
  cwd: string;
  onOutput?: (chunk: string) => void;
}

export type AgentRunner = (invocation: AgentInvocation) => Promise<CommandResult>;
export type VerifyRunner = (command: string, cwd: string) => Promise<CommandResult>;

export interface BuildProgramOptions {
  cwd: string;
  programId: string;
  startFrom?: string;
  dryRun?: boolean;
  approve?: boolean;
  agentRunner?: AgentRunner;
  verifyRunner?: VerifyRunner;
  now?: () => Date;
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
}

export type BuildOutcome =
  | "COMPLETE"
  | "FAILED"
  | "ABORTED"
  | "PLANNED"
  | "APPROVAL_REQUIRED";

export interface BuildProgramResult {
  programId: string;
  result: BuildOutcome;
  reason?: string;
  /** The resolved agent invocation (command and args), when configured. */
  agent?: string;
  plan: PlanEntry[];
  outcomes: WorkstreamOutcome[];
  eventsPath?: string;
}

interface ManifestWorkstream {
  id: string;
  name: string;
  taskFile: string;
  status: string;
  dependencies: string[];
}

// In-memory output is kept to a bounded tail; full output belongs in the
// per-workstream log via onOutput streaming.
const OUTPUT_TAIL_LIMIT = 200_000;

/**
 * Environment for workstream agents: the parent may itself be an agent
 * session (Claude Code, Cursor), and inherited session markers can make the
 * child CLI behave as if attached to that session instead of running as a
 * clean headless agent.
 */
export function sanitizedEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    if (key === "CURSOR_AGENT" || key.startsWith("CURSOR_TRACE_")) continue;
    env[key] = value;
  }
  return env;
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    shell: boolean;
    onOutput?: (chunk: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    let buffered = "";
    const push = (chunk: string): void => {
      options.onOutput?.(chunk);
      buffered = (buffered + chunk).slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", rejectPromise);
    let inputError: Error | undefined;
    child.stdin.on("error", (error: Error) => {
      inputError = error;
    });
    child.on("close", (code) =>
      resolvePromise({
        exitCode: code ?? 1,
        output: buffered,
        ...(inputError ? { inputError: inputError.message } : {}),
      }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export const defaultAgentRunner: AgentRunner = (invocation) =>
  runProcess(
    invocation.command,
    invocation.promptMode === "argument"
      ? [...invocation.args, invocation.prompt]
      : invocation.args,
    {
      cwd: invocation.cwd,
      shell: process.platform === "win32",
      env: sanitizedEnvironment(),
      ...(invocation.onOutput ? { onOutput: invocation.onOutput } : {}),
      ...(invocation.promptMode === "stdin"
        ? { input: invocation.prompt }
        : {}),
    },
  );

export const defaultVerifyRunner: VerifyRunner = (command, cwd) =>
  runProcess(command, [], { cwd, shell: true });

function tail(output: string, limit = 2000): string {
  return output.length > limit ? output.slice(-limit) : output;
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
 * verification cover the remainder.
 */
async function treeSignature(root: string): Promise<string | undefined> {
  try {
    const status = await runProcess("git", ["status", "--porcelain", "-uall"], {
      cwd: root,
      shell: false,
    });
    if (status.exitCode !== 0) return undefined;
    const diff = await runProcess("git", ["diff", "HEAD"], {
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

/** Paths annotated (NEW) in the spec's Files Touched section. */
function declaredNewFiles(specMarkdown: string): string[] {
  const filesTouched = specSection(
    specMarkdown,
    SPEC_CONTRACT.sections.filesTouched,
  );
  if (!filesTouched) return [];
  const files: string[] = [];
  for (const line of filesTouched.split(/\r?\n/u)) {
    if (!/\(NEW\)/u.test(line)) continue;
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
- Do not commit changes, bypass hooks, or weaken verification.

STEP 3 - VERIFY (mandatory):
These exact commands are re-run independently after you finish; the workstream
fails unless every one of them exits successfully:
${verification}
- Fix all errors and repeat verification until every command exits successfully.

RULES:
- Create files marked (NEW); edit existing files marked (MODIFY).
- Replace any prior-workstream stub with the complete implementation.
- Stop and report a blocker rather than silently skipping a requirement.
`;
}

function recoveryPrompt(
  workstream: ManifestWorkstream,
  failureReason: string,
  failureOutput: string,
): string {
  return `Workstream '${workstream.id}: ${workstream.name}' failed its previous build attempt.

- Read the workstream spec: ${workstream.taskFile}
- ${failureReason}
- Output tail:
${tail(failureOutput)}

- Fix only the implementation and tests required by this workstream.
- Ensure the project's verification commands exit successfully.
- Do not commit changes, bypass hooks, or weaken verification.
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

function resolveAgent(config: PipelineConfig): AgentConfig | undefined {
  if (config.agent) return config.agent;
  const command = process.env.PROGRAM_PIPELINE_AGENT_COMMAND;
  if (command && command.trim().length > 0) {
    return { command, args: [], promptMode: "stdin" };
  }
  return undefined;
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
  const agentLabel = agent
    ? [agent.command, ...agent.args].join(" ")
    : undefined;
  const agentField = agentLabel === undefined ? {} : { agent: agentLabel };

  if (options.dryRun) {
    return {
      programId: options.programId,
      result: "PLANNED",
      ...agentField,
      plan,
      outcomes: [],
    };
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

  const logDir = join(root, config.build.logDir);
  await mkdir(logDir, { recursive: true });
  const stamp = now().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
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

  await emit("build-start", {
    programId: options.programId,
    plan,
    agentCommand: agent.command,
    verify: Object.keys(verifyCommands),
  });

  const treeGuardAvailable = (await treeSignature(root)) !== undefined;
  if (!treeGuardAvailable) {
    await emit("tree-guard-disabled", {
      reason:
        "not a git repository or git unavailable; no-op detection limited to declared (NEW) files",
    });
  }

  const outcomes: WorkstreamOutcome[] = [];
  const byId = new Map(ordered.map((workstream) => [workstream.id, workstream]));

  for (const entry of plan) {
    if (entry.action === "skip") {
      await emit("workstream-skipped", { id: entry.id, reason: entry.reason });
      continue;
    }
    const workstream = byId.get(entry.id) as ManifestWorkstream;
    const workstreamLog = join(logDir, `${options.programId}-${workstream.id}.log`);
    const logStream = createWriteStream(workstreamLog, { flags: "a" });
    const agentExitCodes: number[] = [];
    let attempts = 0;
    let failedCommand: string | undefined;
    let failureReason = "";
    let failureOutput = "";
    let verified = false;

    await writeWorkstreamStatus(manifestPath, workstream.id, "in_progress");
    await emit("workstream-start", { id: workstream.id, name: workstream.name });

    let newFiles: string[] = [];
    try {
      newFiles = declaredNewFiles(
        await readFile(resolve(root, workstream.taskFile), "utf8"),
      );
    } catch {
      // Preflight validation already guarantees the spec exists.
    }

    try {
      const maxAttempts = 1 + config.build.maxRecoveryAttempts;
      while (attempts < maxAttempts && !verified) {
        attempts += 1;
        const prompt =
          attempts === 1
            ? workstreamPrompt(workstream, verifyCommands)
            : recoveryPrompt(workstream, failureReason, failureOutput);
        const baseline = treeGuardAvailable
          ? await treeSignature(root)
          : undefined;

        logStream.write(
          `=== attempt ${attempts} (${now().toISOString()}) ===\n--- prompt ---\n${prompt}\n--- agent output ---\n`,
        );
        await emit("agent-start", {
          id: workstream.id,
          attempt: attempts,
          promptBytes: Buffer.byteLength(prompt, "utf8"),
        });
        let agentResult: CommandResult;
        try {
          agentResult = await agentRunner({
            command: agent.command,
            args: agent.args,
            prompt,
            promptMode: agent.promptMode,
            cwd: root,
            onOutput: (chunk) => logStream.write(chunk),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emit("agent-error", { id: workstream.id, attempt: attempts, message });
          await writeWorkstreamStatus(manifestPath, workstream.id, "failed");
          outcomes.push({
            id: workstream.id,
            status: "failed",
            attempts,
            agentExitCodes,
          });
          return {
            programId: options.programId,
            result: "FAILED",
            reason: `Agent command failed to start for ${workstream.id}: ${message}`,
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
          exitCode: agentResult.exitCode,
          ...(agentResult.inputError
            ? { inputError: agentResult.inputError }
            : {}),
        });

        // A failed prompt delivery fails the attempt regardless of exit code:
        // an agent that never received instructions can exit 0 against an
        // already-green repo and would otherwise be falsely completed.
        if (agentResult.inputError) {
          verified = false;
          failedCommand = undefined;
          failureReason = `The prompt could not be delivered to the agent's stdin (${agentResult.inputError}); the agent likely ran without instructions.`;
          failureOutput = agentResult.output;
          logStream.write(
            `=== prompt delivery failed: ${agentResult.inputError} ===\n`,
          );
          continue;
        }

        // A nonzero agent exit fails the attempt outright; verification alone
        // must never rubber-stamp a workstream the agent did not finish.
        if (agentResult.exitCode !== 0) {
          verified = false;
          failedCommand = undefined;
          failureReason = `The agent process exited with code ${agentResult.exitCode} before completing the workstream.`;
          failureOutput = agentResult.output;
          logStream.write(
            `=== agent exited with code ${agentResult.exitCode} ===\n`,
          );
          continue;
        }

        // No-op guards: an agent that exits cleanly without implementing
        // anything must never reach verification, because verification of an
        // already-green repo would falsely complete the workstream.
        if (baseline !== undefined) {
          const after = await treeSignature(root);
          if (after === baseline) {
            verified = false;
            failedCommand = undefined;
            failureReason =
              "The agent exited successfully but made no changes to the working tree; the workstream was not implemented.";
            failureOutput = agentResult.output;
            await emit("no-op", {
              id: workstream.id,
              attempt: attempts,
              kind: "tree-unchanged",
            });
            logStream.write("=== no-op: working tree unchanged ===\n");
            continue;
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
          await emit("no-op", {
            id: workstream.id,
            attempt: attempts,
            kind: "missing-new-files",
            missing: missingNew,
          });
          logStream.write(
            `=== declared (NEW) files missing: ${missingNew.join(", ")} ===\n`,
          );
          continue;
        }

        failedCommand = undefined;
        failureOutput = "";
        verified = true;
        for (const [name, command] of Object.entries(verifyCommands)) {
          await emit("verify-start", { id: workstream.id, attempt: attempts, name });
          const verifyResult = await verifyRunner(command, root);
          await emit("verify-result", {
            id: workstream.id,
            attempt: attempts,
            name,
            command,
            exitCode: verifyResult.exitCode,
          });
          if (verifyResult.exitCode !== 0) {
            verified = false;
            failedCommand = command;
            failureReason = `It failed independent verification; the failing command was: ${command}`;
            failureOutput = verifyResult.output;
            logStream.write(
              `=== verification failed: ${command} ===\n${tail(verifyResult.output)}\n`,
            );
            break;
          }
        }
      }
    } finally {
      await new Promise<void>((resolveStream) => logStream.end(resolveStream));
    }

    if (verified) {
      await writeWorkstreamStatus(manifestPath, workstream.id, "complete");
      await emit("workstream-complete", { id: workstream.id, attempts });
      outcomes.push({
        id: workstream.id,
        status: "complete",
        attempts,
        agentExitCodes,
      });
    } else {
      await writeWorkstreamStatus(manifestPath, workstream.id, "failed");
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
        ...(failedCommand === undefined ? {} : { failedCommand }),
      });
      await emit("build-failed", { id: workstream.id });
      return {
        programId: options.programId,
        result: "FAILED",
        reason: `Workstream ${workstream.id} failed after ${attempts} attempt(s); see ${workstreamLog}.`,
        ...agentField,
        plan,
        outcomes,
        eventsPath,
      };
    }
  }

  await emit("build-complete", {
    programId: options.programId,
    workstreams: outcomes.length,
  });
  return {
    programId: options.programId,
    result: "COMPLETE",
    ...agentField,
    plan,
    outcomes,
    eventsPath,
  };
}
