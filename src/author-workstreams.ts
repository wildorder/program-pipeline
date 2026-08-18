import { createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveAuthorAgent,
  tail,
  type AgentRunner,
  type CommandResult,
} from "./agent-runner.js";
import {
  resolveSummary,
  summaryEventData,
  summaryLine,
  type AgentSummary,
} from "./agent-summary.js";
import {
  assessRepositoryExecutionFit,
  type ExecutionFitClassification,
} from "./execution-fit.js";
import {
  composeAuthorBrief,
  type AuthorTarget,
  type RosterEntry,
  type WorkstreamScope,
} from "./author-brief.js";
import { topologicalLevels } from "./graph.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";
import {
  describeEdges,
  reconcileDependencies,
  writeMergedDependencies,
  type DependencyEdge,
  type UnmetRequirement,
} from "./reconcile-dependencies.js";
import { extractJson, hasArrayKey } from "./validate-loop.js";
import { SPEC_CONTRACT } from "./validate.js";
import { ignoredArtifacts } from "./artifact-status.js";
import { identify } from "./findings.js";
import { writeReplanReport } from "./replan-report.js";
import {
  LEGACY_PLAN_GENERATION,
  legacyGenerationFingerprint,
  readPlanGeneration,
  specGeneration,
  stampSpecGeneration,
  atomicWriteText,
} from "./plan-generation.js";

/**
 * Author one spec per workstream, each in its own clean agent.
 *
 * Authoring every spec in a single session degrades the later ones: workstream
 * eight is written in a window already carrying one through seven. Spawning a
 * fresh agent per workstream removes that, but a flat fan-out replaces it with
 * a worse problem — two dependent workstreams authored in isolation disagree
 * about the interface between them, and nobody notices until build.
 *
 * So the fan-out walks dependency *levels*. Independent workstreams author
 * concurrently; a workstream that depends on another waits and receives that
 * one's finished spec. The edge is directional, so there is nothing to
 * negotiate: the producer decided, and the consumer conforms.
 *
 * Discovery is separate from conformance. Every brief carries the full
 * roster — id, name, and scope of every workstream in the program — because
 * an author that cannot see a workstream exists will not merely omit the
 * dependency, it will reimplement that workstream's work. Knowing a node
 * exists costs a few lines; conforming to it costs its whole spec, and is
 * only paid for declared dependencies.
 */

export interface AuthorDeclaration {
  /** Every workstream this spec consumes output from, as the author saw it. */
  dependencies: string[];
  /** Dependencies whose full spec the author needed and did not have. */
  needs: string[];
  /** Requirements no workstream in the roster provides: a coverage gap. */
  unmet: string[];
  /** Structural reasons this scope cannot be an independently green checkpoint. */
  replan: string[];
}

export interface AuthorWorkstreamOutcome {
  id: string;
  status: "authored" | "skipped" | "failed";
  reason?: string;
  summary?: string;
  declaration: AuthorDeclaration;
  /** Size of the composed brief; telemetry for context budgeting. */
  promptBytes?: number;
  /** Direct dependencies cut to their roster entry to fit the budget. */
  demoted?: string[];
  /** Which reconciliation pass authored this; 2 or more means re-authored. */
  pass?: number;
  executionFit?: {
    classification: ExecutionFitClassification;
    workingSetTokens: number;
    lowerBoundTokens: number;
    upperBoundTokens: number;
  };
}

/** What one reconciliation pass merged, and what it sent back for a re-run. */
export interface ReconciliationRecord {
  pass: number;
  added: DependencyEdge[];
  unknown: DependencyEdge[];
  reauthored: string[];
}

export type AuthorOutcome =
  | "COMPLETE"
  | "FAILED"
  | "PLANNED"
  | "ABORTED"
  | "REQUIRES_REPLAN";

export interface AuthorProgramResult {
  programId: string;
  result: AuthorOutcome;
  reason?: string;
  /** The resolved authoring agent, when configured. */
  agent?: string;
  /** Workstream IDs grouped into the levels they author in. */
  levels: string[][];
  outcomes: AuthorWorkstreamOutcome[];
  reconciliation: ReconciliationRecord[];
  /** Cycles the merged graph would contain; set on REQUIRES_REPLAN. */
  cycles?: string[][];
  /** Requirements no workstream provides; set on REQUIRES_REPLAN. */
  unmet?: UnmetRequirement[];
  /** Non-atomic scopes or unsafe migration ordering reported by authors. */
  replan?: Array<{ workstreamId: string; reason: string }>;
  eventsPath?: string;
  replanReport?: string;
  /** Canonical plan/spec artifacts read or written by this run. */
  artifactPaths?: string[];
  /** Artifacts hidden by the repository's ignore rules. */
  ignoredArtifacts?: string[];
}

export interface AuthorProgramOptions {
  cwd: string;
  programId: string;
  /** Author only these workstreams; used to re-author after reconciliation. */
  only?: string[];
  /** Re-author specs that already exist. */
  force?: boolean;
  dryRun?: boolean;
  agentRunner?: AgentRunner;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

interface ManifestWorkstream {
  id: string;
  name: string;
  taskFile: string;
  status: string;
  dependencies: string[];
  scope?: {
    summary?: string;
    includes?: string[];
    excludes?: string[];
  };
}

const WORKSTREAM_ID = new RegExp(`^${SPEC_CONTRACT.workstreamIdPattern}$`, "u");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return [...new Set(items)];
}

/**
 * The manifest's scope for a workstream, or undefined when it has none. The
 * summary is what makes a roster entry useful; a workstream carrying only
 * includes and excludes is treated as unscoped.
 */
export function readScope(
  raw: ManifestWorkstream["scope"],
): WorkstreamScope | undefined {
  const summary = typeof raw?.summary === "string" ? raw.summary.trim() : "";
  if (summary === "") return undefined;
  return {
    summary,
    includes: cleanList(raw?.includes),
    excludes: cleanList(raw?.excludes),
  };
}

/**
 * Parse the author's structured tail. Anything that does not fit the contract
 * is dropped rather than guessed at: a malformed declaration must not invent
 * a dependency edge that later gets written into the manifest.
 */
export function parseDeclaration(output: string): AuthorDeclaration {
  // Shape-matched, so a spec fragment the author quotes after its declaration
  // cannot be mistaken for the declaration itself.
  const parsed = extractJson(
    output,
    (value) =>
      hasArrayKey(value, "dependencies") ||
      hasArrayKey(value, "needs") ||
      hasArrayKey(value, "unmet") ||
      hasArrayKey(value, "replan"),
  );
  const empty: AuthorDeclaration = {
    dependencies: [],
    needs: [],
    unmet: [],
    replan: [],
  };
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;
  const workstreamIds = (value: unknown): string[] =>
    cleanList(value).filter((id) => WORKSTREAM_ID.test(id));
  return {
    dependencies: workstreamIds(record.dependencies),
    needs: workstreamIds(record.needs),
    unmet: cleanList(record.unmet),
    replan: cleanList(record.replan),
  };
}

/**
 * Drop the largest dependency specs until the rest fit the budget. Largest
 * first keeps the most specs in the brief; the dropped ones remain visible as
 * roster entries, so the author can still see they exist and ask for one back
 * through `needs`.
 */
export function fitDependencySpecs(
  specs: Array<{ id: string; path: string; content: string }>,
  budget: number,
): {
  kept: Array<{ id: string; path: string; content: string }>;
  demoted: string[];
} {
  const kept = [...specs];
  const demoted: string[] = [];
  const total = (): number =>
    kept.reduce((sum, spec) => sum + spec.content.length, 0);

  while (kept.length > 0 && total() > budget) {
    let largest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      const candidate = kept[index];
      const current = kept[largest];
      if (candidate && current && candidate.content.length > current.content.length) {
        largest = index;
      }
    }
    const [dropped] = kept.splice(largest, 1);
    if (dropped) demoted.push(dropped.id);
  }

  return { kept, demoted: demoted.sort() };
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function authorWorkstreams(
  options: AuthorProgramOptions,
): Promise<AuthorProgramResult> {
  const root = resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const runAgent = options.agentRunner ?? defaultAgentRunner;
  const progress = options.onProgress ?? ((): void => {});

  const aborted = (reason: string): AuthorProgramResult => ({
    programId: options.programId,
    result: "ABORTED",
    reason,
    levels: [],
    outcomes: [],
    reconciliation: [],
  });

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }

  // Authoring runs `authorAgent`, the same block the convergence loop uses:
  // writing a spec and judging one are the same kind of work, and neither is
  // the build agent's job.
  const author = resolveAuthorAgent(config);
  if (!author) {
    return aborted(
      'No `authorAgent` or `agent` configured in pipeline.config.json; authoring needs an agent to spawn.',
    );
  }
  const agentLabel = describeAgent(author.agent);
  progress(`agents: author ${agentLabel}`);
  if (author.borrowedBuildAgent) {
    progress(
      `WARNING: no authorAgent configured; borrowing the build agent (${agentLabel}) to author specs. The build agent is often set to a cheaper model on purpose — set authorAgent in pipeline.config.json.`,
    );
  }

  const manifestPath = join(
    root,
    "docs",
    "programs",
    `${options.programId}-manifest.json`,
  );
  let workstreams: ManifestWorkstream[];
  let manifestRaw: string;
  let planGeneration: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
    workstreams = (
      JSON.parse(manifestRaw) as { workstreams?: ManifestWorkstream[] }
      ).workstreams ?? [];
    planGeneration = await readPlanGeneration(manifestPath);
  } catch (error) {
    return aborted(
      `Could not read ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (workstreams.length === 0) {
    return aborted(`No workstreams in ${manifestPath}.`);
  }

  // The roster is load-bearing for discovery, so an unscoped manifest cannot
  // author. Refuse before spending anything and point at where scope is set.
  const scopes = new Map<string, WorkstreamScope>();
  const unscoped: string[] = [];
  for (const workstream of workstreams) {
    const scope = readScope(workstream.scope);
    if (scope) scopes.set(workstream.id, scope);
    else unscoped.push(workstream.id);
  }
  if (unscoped.length > 0) {
    return aborted(
      `These workstreams have no \`scope.summary\` in the manifest: ${unscoped.join(", ")}. Authoring gives every agent the roster of the whole program so it can discover work it depends on or would otherwise duplicate, and a workstream with no scope is invisible in that roster. Add scope (summary, includes, excludes) via /plan-program and re-run.`,
    );
  }

  let levels: ManifestWorkstream[][];
  try {
    levels = topologicalLevels(workstreams);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }
  const levelIds = levels.map((level) => level.map(({ id }) => id));

  const roster: RosterEntry[] = workstreams.map((workstream) => ({
    id: workstream.id,
    name: workstream.name,
    scope: scopes.get(workstream.id) as WorkstreamScope,
  }));

  const only = options.only ? new Set(options.only) : undefined;
  const byId = new Map(workstreams.map((workstream) => [workstream.id, workstream]));

  if (options.dryRun) {
    return {
      programId: options.programId,
      result: "PLANNED",
      agent: agentLabel,
      levels: levelIds,
      outcomes: [],
      reconciliation: [],
    };
  }

  const logDir = join(root, config.build.logDir);
  await mkdir(logDir, { recursive: true });
  const stamp = now().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const eventsPath = join(logDir, `${options.programId}-author-${stamp}.jsonl`);
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

  const shared = {
    programDoc:
      (await readOptional(
        join(root, "docs", "programs", `${options.programId}-program.md`),
      )) ?? "(program document not found)",
    manifest: manifestRaw,
    agentsMd: await readOptional(join(root, "AGENTS.md")),
    vision: config.visionPath
      ? await readOptional(resolve(root, config.visionPath))
      : undefined,
    contextDocs: [] as Array<{ path: string; content: string }>,
  };
  if (planGeneration === LEGACY_PLAN_GENERATION) {
    planGeneration = legacyGenerationFingerprint(shared.manifest, shared.programDoc);
  }
  for (const path of config.contextDocs) {
    const content = await readOptional(resolve(root, path));
    if (content !== undefined) shared.contextDocs.push({ path, content });
  }

  await emit("author-start", {
    programId: options.programId,
    levels: levelIds,
    agentCommand: author.agent.command,
    concurrency: config.author.concurrency,
  });
  progress(
    `author ${options.programId}: ${workstreams.length} workstream(s) in ${levels.length} level(s), agent: ${agentLabel}`,
  );

  const outcomes: AuthorWorkstreamOutcome[] = [];
  const empty: AuthorDeclaration = {
    dependencies: [],
    needs: [],
    unmet: [],
    replan: [],
  };

  const authorOne = async (
    workstream: ManifestWorkstream,
    force: boolean,
  ): Promise<AuthorWorkstreamOutcome> => {
    const specPath = resolve(root, workstream.taskFile);

    if (!force && (await pathExists(specPath))) {
      const existing = await readFile(specPath, "utf8");
      const existingGeneration = specGeneration(existing);
      // Legacy plans predate generation markers. Preserve their existing
      // behavior without dirtying the user's tree; every replan produced by
      // the current planner carries an explicit generation and is strict.
      if (existingGeneration === undefined && planGeneration === LEGACY_PLAN_GENERATION) {
        return {
          id: workstream.id,
          status: "skipped",
          reason: "spec already exists",
          declaration: empty,
        };
      } else if (existingGeneration === undefined && planGeneration.startsWith("legacy-")) {
        return {
          id: workstream.id,
          status: "skipped",
          reason: "spec already exists",
          declaration: empty,
        };
      } else if (existingGeneration !== planGeneration) {
        // Fall through to author a replacement at the manifest's new path.
      } else {
        return {
          id: workstream.id,
          status: "skipped",
          reason: "spec already exists",
          declaration: empty,
        };
      }
    }

    const dependencySpecs: Array<{ id: string; path: string; content: string }> =
      [];
    for (const dependencyId of workstream.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      const content = await readOptional(resolve(root, dependency.taskFile));
      if (content !== undefined) {
        dependencySpecs.push({
          id: dependencyId,
          path: dependency.taskFile,
          content,
        });
      }
    }
    const { kept, demoted } = fitDependencySpecs(
      dependencySpecs,
      config.author.maxDependencySpecChars,
    );
    if (demoted.length > 0) {
      await emit("dependency-specs-demoted", {
        id: workstream.id,
        demoted,
        budget: config.author.maxDependencySpecChars,
      });
      progress(
        `${workstream.id} dependency specs over budget; roster-only for: ${demoted.join(", ")}`,
      );
    }

    const target: AuthorTarget = {
      id: workstream.id,
      name: workstream.name,
      taskFile: workstream.taskFile,
      dependencies: workstream.dependencies,
      scope: scopes.get(workstream.id) as WorkstreamScope,
    };
    const prompt = composeAuthorBrief({
      programId: options.programId,
      target,
      roster,
      dependencySpecs: kept,
      demoted,
      programDoc: shared.programDoc,
      manifest: shared.manifest,
      ...(shared.agentsMd === undefined ? {} : { agentsMd: shared.agentsMd }),
      ...(shared.vision === undefined ? {} : { vision: shared.vision }),
      contextDocs: shared.contextDocs,
    });
    const promptBytes = Buffer.byteLength(prompt, "utf8");

    const logPath = join(
      logDir,
      `${options.programId}-${workstream.id}-author.log`,
    );
    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.write(
      `=== author ${workstream.id} (${now().toISOString()}) ===\n--- prompt ---\n${prompt}\n--- agent output ---\n`,
    );

    await emit("author-agent-start", {
      id: workstream.id,
      promptBytes,
      dependencySpecs: kept.map(({ id }) => id),
    });
    progress(`${workstream.id} authoring: ${workstream.name}`);

    let result: CommandResult;
    try {
      result = await runAgent({
        command: author.agent.command,
        args: author.agent.args,
        prompt,
        promptMode: author.agent.promptMode,
        cwd: root,
        onOutput: (chunk) => logStream.write(chunk),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await new Promise<void>((done) => logStream.end(done));
      await emit("author-agent-error", { id: workstream.id, message });
      progress(`${workstream.id} agent failed to start: ${message}`);
      return {
        id: workstream.id,
        status: "failed",
        reason: `Agent command failed to start: ${message}`,
        declaration: empty,
        promptBytes,
      };
    }
    await new Promise<void>((done) => logStream.end(done));

    const summary: AgentSummary = resolveSummary(result.output);
    const declaration = parseDeclaration(result.output);
    await emit("author-agent-exit", {
      id: workstream.id,
      exitCode: result.exitCode,
      ...(result.inputError ? { inputError: result.inputError } : {}),
    });
    await emit("agent-summary", {
      id: workstream.id,
      ...summaryEventData("author", prompt, summary),
    });
    progress(`${workstream.id} summary: ${summaryLine(summary)}`);
    await emit("author-declaration", { id: workstream.id, ...declaration });

    const base: AuthorWorkstreamOutcome = {
      id: workstream.id,
      status: "authored",
      declaration,
      summary: summary.text,
      promptBytes,
      ...(demoted.length > 0 ? { demoted } : {}),
    };

    // A failed prompt delivery fails the attempt regardless of exit code: an
    // agent that never received instructions can still exit 0.
    if (result.inputError) {
      return {
        ...base,
        status: "failed",
        reason: `The prompt could not be delivered to the agent's stdin (${result.inputError}); the agent likely ran without instructions.`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        ...base,
        status: "failed",
        reason: `The agent exited ${result.exitCode}: ${tail(result.output, 300).trim()}`,
      };
    }
    // The spec file is this command's equivalent of the build runner's
    // declared-(NEW)-files check: an agent that exits clean without writing
    // the spec has not authored anything.
    if (!(await pathExists(specPath))) {
      return {
        ...base,
        status: "failed",
        reason: `The agent exited successfully but ${workstream.taskFile} does not exist.`,
      };
    }
    const authored = await readFile(specPath, "utf8");
    await atomicWriteText(specPath, stampSpecGeneration(authored, planGeneration));

    await emit("workstream-authored", {
      id: workstream.id,
      taskFile: workstream.taskFile,
      dependencies: declaration.dependencies,
    });
    progress(`${workstream.id} authored -> ${workstream.taskFile}`);
    return base;
  };

  const reconciliation: ReconciliationRecord[] = [];
  let currentLevels = levelIds;

  const runPass = async (
    selection: Set<string> | undefined,
    force: boolean,
    pass: number,
  ): Promise<{
    outcomes: AuthorWorkstreamOutcome[];
    failedLevel?: number;
    requestedReplan?: Array<{ workstreamId: string; reason: string }>;
  }> => {
    // Recomputed each pass: a merged edge can move a workstream to a later
    // level than the one it authored in before.
    const passLevels = topologicalLevels(workstreams);
    currentLevels = passLevels.map((level) => level.map(({ id }) => id));
    const passOutcomes: AuthorWorkstreamOutcome[] = [];

    for (const [index, level] of passLevels.entries()) {
      const selected = level.filter(
        (workstream) => !selection || selection.has(workstream.id),
      );
      if (selected.length === 0) continue;

      await emit("level-start", {
        pass,
        level: index + 1,
        workstreams: selected.map(({ id }) => id),
      });
      progress(
        `pass ${pass} level ${index + 1}/${passLevels.length}: ${selected
          .map(({ id }) => id)
          .join(", ")}`,
      );

      const levelOutcomes = (
        await mapWithConcurrency(
          selected,
          config.author.concurrency,
          (workstream) => authorOne(workstream, force),
        )
      ).map((outcome) => ({ ...outcome, pass }));
      passOutcomes.push(...levelOutcomes);

      const requestedReplan = levelOutcomes.flatMap(({ id, declaration }) =>
        declaration.replan.map((reason) => ({ workstreamId: id, reason })),
      );
      if (requestedReplan.length > 0) {
        return { outcomes: passOutcomes, requestedReplan };
      }

      // Later levels read the specs this one produced, so a level that did
      // not fully succeed stops rather than authoring against a hole.
      if (levelOutcomes.some(({ status }) => status === "failed")) {
        return { outcomes: passOutcomes, failedLevel: index + 1 };
      }
    }
    return { outcomes: passOutcomes };
  };

  let selection = only;
  let force = options.force ?? false;

  for (let pass = 1; pass <= config.author.maxReconcilePasses; pass += 1) {
    const {
      outcomes: passOutcomes,
      failedLevel,
      requestedReplan,
    } = await runPass(
      selection,
      force,
      pass,
    );
    outcomes.push(...passOutcomes);

    if (failedLevel !== undefined) {
      const failed = passOutcomes.filter(({ status }) => status === "failed");
      await emit("author-failed", {
        pass,
        level: failedLevel,
        workstreams: failed.map(({ id }) => id),
      });
      const detail = failed
        .map(({ id, reason }) => `${id}: ${reason ?? "failed"}`)
        .join(" | ");
      progress(`level ${failedLevel} failed: ${detail}`);
      return {
        programId: options.programId,
        result: "FAILED",
        reason: `Authoring failed in level ${failedLevel}; later levels depend on these specs. ${detail}`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        eventsPath,
      };
    }

    if (requestedReplan && requestedReplan.length > 0) {
      const detail = requestedReplan
        .map(({ workstreamId, reason }) => `${workstreamId}: ${reason}`)
        .join("; ");
      await emit("requires-replan", {
        pass,
        reason: "unsafe checkpoint",
        replan: requestedReplan,
      });
      progress(
        `pass ${pass}: workstream scope is not independently green: ${detail}`,
      );
      const replanReport = await writeReplanReport(
        root,
        options.programId,
        config,
        {
          summary: `Authoring found ${requestedReplan.length} structural checkpoint defect(s) before convergence.`,
          replanFindings: requestedReplan.map(({ workstreamId, reason }) =>
            identify({
              severity: "blocker",
              category: "scope-structure",
              subject: `Author checkpoint ${workstreamId}`,
              message: reason,
              evidence: [{ kind: "concern", named: "author-declared unsafe checkpoint", detail: workstreamId }],
              workstreamId,
              requiresReplan: true,
            }),
          ),
          relatedFindings: [],
          checkpointAssessments: [],
          criticSummary: detail,
          criticLogs: [eventsPath],
        },
      );
      return {
        programId: options.programId,
        result: "REQUIRES_REPLAN",
        reason: `These workstreams cannot be implemented as independently green checkpoints: ${detail}. Replan the scope or migration order before authoring later workstreams.`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        replan: requestedReplan,
        replanReport: replanReport.path,
        eventsPath,
      };
    }

    const reconciled = reconcileDependencies({
      workstreams: workstreams.map(({ id, dependencies }) => ({
        id,
        dependencies,
      })),
      declarations: passOutcomes
        .filter(({ status }) => status === "authored")
        .map((outcome) => ({
          workstreamId: outcome.id,
          ...outcome.declaration,
        })),
    });

    if (reconciled.unknown.length > 0) {
      await emit("dependency-unknown", { pass, edges: reconciled.unknown });
      progress(
        `pass ${pass}: ignoring declared edges that name no workstream: ${describeEdges(reconciled.unknown)}`,
      );
    }

    // A cycle is a decomposition error, not a bookkeeping one, and writing it
    // would leave a manifest neither validate nor build can order.
    if (reconciled.cycles.length > 0) {
      const detail = reconciled.cycles
        .map((cycle) => cycle.join(" -> "))
        .join("; ");
      await emit("requires-replan", {
        pass,
        reason: "dependency cycle",
        cycles: reconciled.cycles,
      });
      progress(`pass ${pass}: merging declared edges would cycle: ${detail}`);
      reconciliation.push({
        pass,
        added: [],
        unknown: reconciled.unknown,
        reauthored: [],
      });
      return {
        programId: options.programId,
        result: "REQUIRES_REPLAN",
        reason: `Merging the dependencies these authors declared would create a cycle: ${detail}. Two workstreams that depend on each other are one workstream, or are split in the wrong place — no manifest edit fixes that. The manifest was left unchanged; take this back to /plan-program.`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        cycles: reconciled.cycles,
        eventsPath,
      };
    }

    if (reconciled.added.length > 0) {
      for (const workstream of workstreams) {
        const merged = reconciled.dependencies.get(workstream.id);
        if (merged) workstream.dependencies = merged;
      }
      await writeMergedDependencies(manifestPath, reconciled.dependencies);
      await emit("dependencies-merged", { pass, added: reconciled.added });
      progress(
        `pass ${pass}: merged ${reconciled.added.length} undeclared dependency edge(s): ${describeEdges(reconciled.added)}`,
      );
    }

    if (reconciled.unmet.length > 0) {
      const detail = reconciled.unmet
        .map(({ workstreamId, requirement }) => `${workstreamId}: ${requirement}`)
        .join("; ");
      await emit("requires-replan", {
        pass,
        reason: "unmet requirements",
        unmet: reconciled.unmet,
      });
      progress(`pass ${pass}: no workstream provides: ${detail}`);
      reconciliation.push({
        pass,
        added: reconciled.added,
        unknown: reconciled.unknown,
        reauthored: [],
      });
      return {
        programId: options.programId,
        result: "REQUIRES_REPLAN",
        reason: `These requirements are provided by no workstream in the program: ${detail}. That is missing scope, which is a planning decision — take it back to /plan-program. Declared dependency edges were still merged into the manifest.`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        unmet: reconciled.unmet,
        eventsPath,
      };
    }

    const reauthored = reconciled.needs.map(({ workstreamId }) => workstreamId);
    reconciliation.push({
      pass,
      added: reconciled.added,
      unknown: reconciled.unknown,
      reauthored,
    });
    if (reauthored.length === 0) break;

    if (pass === config.author.maxReconcilePasses) {
      await emit("author-churn", { pass, workstreams: reauthored });
      return {
        programId: options.programId,
        result: "FAILED",
        reason: `Authoring still asked for dependency specs after ${pass} pass(es): ${reauthored.join(", ")}. Declared edges only ever grow, so this normally settles; raise author.maxReconcilePasses if the program is genuinely this deep, or look at what these authors keep asking for.`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        eventsPath,
      };
    }

    progress(
      `pass ${pass}: re-authoring with newly available specs: ${reauthored.join(", ")}`,
    );
    selection = new Set(reauthored);
    force = true;
  }

  for (const outcome of outcomes) {
    if (outcome.status === "failed") continue;
    const workstream = workstreams.find(({ id }) => id === outcome.id);
    if (!workstream) continue;
    let assessment;
    try {
      assessment = await assessRepositoryExecutionFit(
        {
          root,
          taskPath: workstream.taskFile,
          visionPath: config.visionPath,
          contextDocs: config.contextDocs,
        },
        config.build.executionProfile,
      );
    } catch (error) {
      return {
        programId: options.programId,
        result: "FAILED",
        reason: `Could not estimate execution fit for ${outcome.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        eventsPath,
      };
    }
    outcome.executionFit = {
      classification: assessment.classification,
      workingSetTokens: assessment.workingSetTokens,
      lowerBoundTokens: assessment.lowerBoundTokens,
      upperBoundTokens: assessment.upperBoundTokens,
    };
    await emit("execution-fit", {
      id: outcome.id,
      ...outcome.executionFit,
    });
    if (assessment.hardFailure) {
      return {
        programId: options.programId,
        result: "REQUIRES_REPLAN",
        reason: `${outcome.id}'s minimum estimated working set cannot fit the configured ${config.build.executionProfile.contextWindowTokens}-token context window. Split it or correct the execution profile before building.`,
        agent: agentLabel,
        levels: currentLevels,
        outcomes,
        reconciliation,
        replan: [
          {
            workstreamId: outcome.id,
            reason: "minimum static working set exceeds physical context capacity",
          },
        ],
        eventsPath,
      };
    }
    if (assessment.classification !== "normal") {
      progress(
        `${outcome.id} execution fit: ${assessment.classification} at approximately ${assessment.workingSetTokens} tokens (${assessment.lowerBoundTokens}-${assessment.upperBoundTokens}); this is advisory unless the physical context cannot fit`,
      );
    }
  }

  const authored = outcomes.filter(({ status }) => status === "authored").length;
  const artifactPaths = [
    `docs/programs/${options.programId}-manifest.json`,
    `docs/programs/${options.programId}-program.md`,
    ...workstreams.map(({ taskFile }) => taskFile),
  ];
  const ignored = await ignoredArtifacts(root, artifactPaths);
  if (ignored.length > 0) {
    progress(`WARNING: canonical plan artifacts are ignored by Git: ${ignored.join(", ")}`);
  }
  await emit("author-complete", { programId: options.programId, authored });
  progress(`author ${options.programId} complete: ${authored} spec(s) written`);

  return {
    programId: options.programId,
    result: "COMPLETE",
    agent: agentLabel,
    levels: currentLevels,
    outcomes,
    reconciliation,
    eventsPath,
    artifactPaths,
    ...(ignored.length > 0 ? { ignoredArtifacts: ignored } : {}),
  };
}
