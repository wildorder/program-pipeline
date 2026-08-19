import { resolve } from "node:path";
import { runProcess, type AgentRunner, type VerifyRunner } from "./agent-runner.js";
import { updateAsBuilt } from "./as-built.js";
import { authorWorkstreams } from "./author-workstreams.js";
import { buildProgram } from "./build-program.js";
import { reviewCriteria } from "./criteria.js";
import { inspectConvergenceReceipt } from "./convergence-receipt.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";
import { reviewProgram } from "./review-program.js";
import { validateLoop } from "./validate-loop.js";
import { validateWorkstreams } from "./validate.js";
import { replanProgram } from "./replan-program.js";
import { auditPlan } from "./plan-audit.js";
import {
  readProgramExecutionMode,
  type ExecutionMode,
} from "./execution-mode.js";

/**
 * Run the whole pipeline: one command from a planned program to a built one.
 *
 * The individual commands exist because each stage needed its own brief, its
 * own agent, and its own failure semantics. But composing them by hand meant
 * eight invocations with manual commits in between, which is more babysitting
 * than the workflow it replaced — the seams were the point, the command count
 * was not supposed to be the price.
 *
 * So this sequences them, commits between stages itself, and stops for a
 * human in exactly one place: the acceptance-criteria gate, and only when
 * that gate is switched on. Everything else either continues or fails loudly.
 *
 * It is also what makes the CI move possible. A workflow file wants one
 * command, not eight with `git commit` between them.
 */

export const RUN_STAGES = [
  "plan-audit",
  "author",
  "validate",
  "converge",
  "review",
  "criteria",
  "build",
  "as-built",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

/** Stages the default run performs, in order. */
const DEFAULT_STAGES: readonly RunStage[] = [
  "plan-audit",
  "author",
  "validate",
  "converge",
  "criteria",
  "build",
  "as-built",
];

export interface RunStageResult {
  stage: RunStage;
  /** The stage command's own outcome string. */
  result: string;
  reason?: string;
  /** Short SHA when this stage's output was committed. */
  commit?: string;
}

export type RunOutcome = "COMPLETE" | "STOPPED" | "FAILED";

export interface RunProgramResult {
  programId: string;
  executionMode?: ExecutionMode;
  result: RunOutcome;
  reason?: string;
  stages: RunStageResult[];
}

export interface RunProgramOptions {
  cwd: string;
  programId: string;
  /** Start here instead of at the beginning; use to resume after a stop. */
  from?: RunStage;
  /** Stop after this stage. */
  to?: RunStage;
  /** Include the advisory architecture review, which is otherwise skipped. */
  review?: boolean;
  /** Do not commit between stages, and pass --no-commit down to the build. */
  commit?: boolean;
  agentRunner?: AgentRunner;
  verifyRunner?: VerifyRunner;
  now?: () => Date;
  onProgress?: (line: string) => void;
  /** Internal bounded automatic replan depth. */
  automaticReplans?: number;
  /** Allow non-blocking semantic findings after convergence exhausts its rounds. */
  allowSemanticRisks?: boolean;
  /** Override the planner-selected execution mode for this run. */
  executionMode?: ExecutionMode;
}

export function parseStage(value: string): RunStage {
  const stage = value.trim().toLowerCase();
  if (!(RUN_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `Unknown stage "${value}". Expected: ${RUN_STAGES.join(", ")}.`,
    );
  }
  return stage as RunStage;
}

/**
 * The stages this run will perform: the default sequence, narrowed by
 * `--from` / `--to`, with `review` included only when asked for.
 */
export function stagesFor(options: {
  from?: RunStage;
  to?: RunStage;
  review?: boolean;
}): RunStage[] {
  const ordered = options.review
    ? RUN_STAGES.filter((stage) => DEFAULT_STAGES.includes(stage) || stage === "review")
    : [...DEFAULT_STAGES];
  const start = options.from ? ordered.indexOf(options.from) : 0;
  const end = options.to ? ordered.indexOf(options.to) : ordered.length - 1;
  if (start < 0 || end < 0 || end < start) return [];
  return ordered.slice(start, end + 1);
}

async function git(
  root: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  return runProcess("git", args, { cwd: root, shell: false });
}

async function isGitRepository(root: string): Promise<boolean> {
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0;
}

/**
 * Uncommitted paths that would be swept into a stage's commit.
 *
 * The runner's own artifacts are exempt, not out of convenience but because
 * they are not user work in progress: the manifest carries workstream
 * statuses and the criteria approval, both written by these commands, and the
 * criteria document is regenerated on every run. Without this, the documented
 * resume path would dead-end — `criteria --approve` edits the manifest, so
 * the very next `run` would refuse to start on the change it just asked for.
 */
async function workingTreeDirty(
  root: string,
  logDir: string,
  programId: string,
): Promise<string[]> {
  const status = await git(root, [
    "status",
    "--porcelain",
    "-uall",
    "--",
    ".",
    `:(exclude)${logDir}`,
    `:(exclude)docs/programs/${programId}-manifest.json`,
    `:(exclude)docs/programs/${programId}-criteria.md`,
  ]);
  if (status.exitCode !== 0) return [];
  return status.output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[ MARC?u!]{2}\s/u.test(line));
}

/**
 * Commit whatever a stage produced. Staging excludes the runner's log
 * directory the same way the build runner does: logs are runner output, not
 * work. A git-side refusal is reported, never fatal.
 */
async function commitStage(
  root: string,
  logDir: string,
  message: string,
): Promise<{ sha?: string; empty?: boolean; error?: string }> {
  const staged = await git(root, ["add", "-A", "--", "."]);
  if (staged.exitCode !== 0) return { error: "git add failed" };
  const held = await git(root, ["reset", "--quiet", "--", logDir]);
  if (held.exitCode !== 0) return { error: "git reset failed" };
  const pending = await git(root, ["diff", "--cached", "--quiet"]);
  if (pending.exitCode === 0) return { empty: true };
  const committed = await git(root, ["commit", "-m", message]);
  if (committed.exitCode !== 0) return { error: "git commit refused" };
  const head = await git(root, ["rev-parse", "--short", "HEAD"]);
  return head.exitCode === 0 ? { sha: head.output.trim() } : {};
}

export async function runProgram(
  options: RunProgramOptions,
): Promise<RunProgramResult> {
  const root = resolve(options.cwd);
  const progress = options.onProgress ?? ((): void => {});
  const stages: RunStageResult[] = [];
  let effectiveMode: ExecutionMode | undefined;
  let assessExecutionMode: boolean;
  let manifestMode: ExecutionMode | undefined;

  const finish = (
    result: RunOutcome,
    reason?: string,
  ): RunProgramResult => ({
    programId: options.programId,
    ...(effectiveMode === undefined ? {} : { executionMode: effectiveMode }),
    result,
    ...(reason === undefined ? {} : { reason }),
    stages,
  });

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return finish("FAILED", error instanceof Error ? error.message : String(error));
  }

  let modeSource: "override" | "manifest" | "legacy";
  try {
    const plannedMode = await readProgramExecutionMode(root, options.programId);
    manifestMode = plannedMode.mode;
    effectiveMode = options.executionMode ?? plannedMode.mode;
    modeSource = options.executionMode !== undefined
      ? "override"
      : plannedMode.declared ? "manifest" : "legacy";
    assessExecutionMode = options.executionMode !== undefined || plannedMode.declared;
    if (effectiveMode === "atomic" && plannedMode.workstreamCount !== 1) {
      return finish(
        "FAILED",
        `Atomic mode requires exactly one whole-program workstream, but the manifest has ${plannedMode.workstreamCount}. Re-plan this program as atomic or run it as orchestrated.`,
      );
    }
  } catch (error) {
    return finish("FAILED", `Could not resolve execution mode: ${error instanceof Error ? error.message : String(error)}`);
  }

  const planned = stagesFor({
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
    review: options.review ?? false,
  });
  if (planned.length === 0) {
    return finish(
      "FAILED",
      `No stages to run: --from ${options.from ?? "(start)"} comes after --to ${options.to ?? "(end)"}.`,
    );
  }

  if (planned.includes("build") && !planned.includes("converge")) {
    let receipt;
    try {
      receipt = await inspectConvergenceReceipt(
        root,
        options.programId,
        config,
      );
    } catch (error) {
      return finish(
        "FAILED",
        `Could not inspect semantic convergence inputs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const overrideChangesRouting = options.executionMode !== undefined &&
      options.executionMode !== manifestMode;
    if (!receipt.valid || overrideChangesRouting) {
      const buildIndex = planned.indexOf("build");
      planned.splice(buildIndex, 0, "validate", "converge");
      progress(
        overrideChangesRouting
          ? "execution-mode override changes semantic routing; automatically running validate and converge before build"
          : `semantic convergence receipt is ${receipt.reason ?? "invalid"}; automatically running validate and converge before build`,
      );
    }
  }

  const logDir = config.build.logDir;
  const wantCommits = options.commit ?? true;
  const inRepository = await isGitRepository(root);
  const commitsEnabled = wantCommits && inRepository;
  if (wantCommits && !inRepository) {
    progress("commits disabled: not a git repository");
  }

  // Same guard the build runner applies, hoisted to the front of the run: the
  // stages commit their own output, and sweeping unrelated work into a
  // machine-authored commit is not something to discover at stage five.
  if (commitsEnabled) {
    const dirty = await workingTreeDirty(root, logDir, options.programId);
    if (dirty.length > 0) {
      return finish(
        "FAILED",
        `The working tree has ${dirty.length} uncommitted change(s), and each stage commits what it produces. Commit or stash them, or re-run with --no-commit. Changes: ${dirty
          .slice(0, 10)
          .join("; ")}${dirty.length > 10 ? "; …" : ""}`,
      );
    }
  }

  progress(`execution mode: ${effectiveMode} (${modeSource})`);
  progress(`run ${options.programId}: ${planned.join(" -> ")}`);

  const record = async (
    stage: RunStage,
    result: string,
    reason: string | undefined,
    commitMessage?: string,
  ): Promise<void> => {
    const entry: RunStageResult = {
      stage,
      result,
      ...(reason === undefined ? {} : { reason }),
    };
    if (commitsEnabled && commitMessage !== undefined) {
      const committed = await commitStage(root, logDir, commitMessage);
      if (committed.sha) {
        entry.commit = committed.sha;
        progress(`${stage}: committed ${committed.sha}`);
      } else if (committed.error) {
        progress(`${stage}: ${committed.error}; changes left in the tree`);
      }
    }
    stages.push(entry);
  };

  const commitAutomaticReplan = async (): Promise<void> => {
    if (!commitsEnabled) return;
    const committed = await commitStage(
      root,
      logDir,
      `plan(${options.programId}): automatic replan`,
    );
    if (committed.sha) progress(`replan: committed ${committed.sha}`);
    else if (committed.error) progress(`replan: ${committed.error}; changes left in the tree`);
  };

  for (const stage of planned) {
    progress(`\n=== ${stage} ===`);

    if (stage === "plan-audit") {
      const result = await auditPlan({
        cwd: root,
        programId: options.programId,
        ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
        ...(options.now ? { now: options.now } : {}),
        executionMode: effectiveMode,
        assessExecutionMode,
        onProgress: progress,
      });
      await record(stage, result.result, result.reason);
      if (result.result === "PASSED") continue;
      if (result.result === "HUMAN_REQUIRED") {
        return finish("FAILED", `Plan audit requires a human requirements decision: ${result.reason ?? "review the reported conflict"}`);
      }
      if (result.result === "REQUIRES_REPLAN" && result.replanReport) {
        const depth = options.automaticReplans ?? 0;
        if (depth < 2) {
          progress(`automatic replan ${depth + 1}/2: repairing plan before authoring`);
          const replanned = await replanProgram({
            cwd: root,
            programId: options.programId,
            ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
            onProgress: progress,
          });
          if (replanned.result === "COMPLETE") {
            await commitAutomaticReplan();
            const resumed = await runProgram({
              ...options,
              from: "plan-audit",
              automaticReplans: depth + 1,
            });
            stages.push(...resumed.stages);
            return finish(resumed.result, resumed.reason);
          }
          progress(`automatic replan failed: ${replanned.reason ?? "unknown error"}`);
        }
      }
      return finish("FAILED", `Plan audit ${result.result}. ${result.reason ?? ""}${result.replanReport ? ` Replan report: ${result.replanReport}` : ""}`.trim());
    }

    if (stage === "author") {
      const result = await authorWorkstreams({
        cwd: root,
        programId: options.programId,
        ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
        ...(options.now ? { now: options.now } : {}),
        onProgress: progress,
      });
      if (result.artifactPaths && result.artifactPaths.length > 0) {
        progress(`author artifacts: ${result.artifactPaths.join(", ")}`);
      }
      if (result.ignoredArtifacts && result.ignoredArtifacts.length > 0) {
        progress(
          `WARNING: these plan artifacts are ignored by Git and will not travel to another runner: ${result.ignoredArtifacts.join(", ")}`,
        );
      }
      await record(
        stage,
        result.result,
        result.reason,
        `specs(${options.programId}): author workstreams`,
      );
      if (result.result === "REQUIRES_REPLAN") {
        const depth = options.automaticReplans ?? 0;
        if (depth < 2 && result.replanReport) {
          progress(`automatic replan ${depth + 1}/2: updating plan artifacts`);
          try {
            const replanned = await replanProgram({
              cwd: root,
              programId: options.programId,
              ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
              onProgress: progress,
            });
            if (replanned.result === "COMPLETE") {
              await commitAutomaticReplan();
              const resumed = await runProgram({
                ...options,
                from: "plan-audit",
                automaticReplans: depth + 1,
              });
              stages.push(...resumed.stages);
              return finish(resumed.result, resumed.reason);
            }
            progress(`automatic replan failed: ${replanned.reason ?? "unknown error"}`);
          } catch (error) {
            progress(`automatic replan failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return finish(
          "FAILED",
          `Authoring needs the program replanned before it can continue. ${result.reason ?? ""}${result.replanReport ? ` Replan report: ${result.replanReport}` : ""}`.trim(),
        );
      }
      if (result.result !== "COMPLETE") {
        return finish("FAILED", `Authoring ${result.result}. ${result.reason ?? ""}`.trim());
      }
      continue;
    }

    if (stage === "validate") {
      // Free and instant, and it runs before the expensive stages on purpose:
      // a mechanical defect found here costs seconds, and the same defect
      // found by the convergence loop costs two agent invocations.
      const report = await validateWorkstreams(root, options.programId);
      const blockers = report.findings.filter(
        ({ severity }) => severity === "blocker",
      );
      await record(stage, report.result, undefined);
      progress(
        `validate: ${report.result} (${blockers.length} blocker(s), ${report.findings.length} finding(s))`,
      );
      if (report.result === "FAILED") {
        return finish(
          "FAILED",
          `Deterministic validation failed with ${blockers.length} blocker(s): ${blockers
            .map(({ code, message }) => `${code}: ${message}`)
            .join(" | ")}`,
        );
      }
      continue;
    }

    if (stage === "converge") {
      const result = await validateLoop({
        cwd: root,
        programId: options.programId,
        ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
        ...(options.now ? { now: options.now } : {}),
        onProgress: progress,
        ...(effectiveMode === "atomic" ? { rounds: 1, allowSemanticRisks: true } : {}),
        ...(effectiveMode === "atomic" || options.allowSemanticRisks === undefined
          ? {}
          : { allowSemanticRisks: options.allowSemanticRisks }),
      });
      await record(
        stage,
        result.result,
        result.reason,
        `specs(${options.programId}): convergence`,
      );
      if (result.outcome === "requires-replan") {
        const details = result.replanFindings
          .map(
            (finding, index) =>
              `${index + 1}. [${finding.workstreamId ?? "program"}] ${finding.subject}: ${finding.message}`,
          )
          .join("\n");
        progress("requires replanning:");
        for (const line of details.split("\n")) progress(`  ${line}`);
        if (result.replanReport) {
          progress(`replan with: /plan-program ${options.programId}`);
          progress(`replan input: ${result.replanReport}`);
        }
        const depth = options.automaticReplans ?? 0;
        if (depth < 2 && result.replanReport) {
          progress(`automatic replan ${depth + 1}/2: updating plan artifacts`);
          let replanned;
          try {
            replanned = await replanProgram({
              cwd: root,
              programId: options.programId,
              ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
              onProgress: progress,
            });
          } catch (error) {
            progress(
              `automatic replan failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            replanned = { result: "FAILED" as const, reason: String(error), changedPaths: [] };
          }
          if (replanned.result === "COMPLETE") {
            await commitAutomaticReplan();
            progress(`automatic replan generation: ${replanned.generation ?? "updated"}`);
            const resumed = await runProgram({
              ...options,
              from: "plan-audit",
              automaticReplans: depth + 1,
            });
            stages.push(...resumed.stages);
            return finish(resumed.result, resumed.reason);
          }
          progress(`automatic replan failed: ${replanned.reason ?? "unknown error"}`);
        }
        return finish(
          "FAILED",
          [
            `The convergence loop found ${result.replanFindings.length} defect(s) no spec edit can fix:`,
            details,
            result.replanReport
              ? `Replan report: ${result.replanReport}\nRun /plan-program ${options.programId}; it will consume this report automatically.`
              : `Run /plan-program ${options.programId} and provide the findings above.`,
          ].join("\n"),
        );
      }
      if (result.outcome === "aborted") {
        return finish("FAILED", `Convergence aborted. ${result.reason ?? ""}`.trim());
      }
      if (result.result === "FAILED") {
        return finish(
          "FAILED",
          `The validation gate failed after convergence. ${result.reason ?? ""}`.trim(),
        );
      }
      continue;
    }

    if (stage === "review") {
      const result = await reviewProgram({
        cwd: root,
        programId: options.programId,
        ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
        ...(options.now ? { now: options.now } : {}),
        onProgress: progress,
      });
      await record(
        stage,
        result.result,
        result.reason,
        `docs(${options.programId}): program review`,
      );
      // A review reports; it never blocks. Only an unusable one stops the run.
      if (result.result === "ABORTED") {
        return finish("FAILED", `Review aborted. ${result.reason ?? ""}`.trim());
      }
      continue;
    }

    if (stage === "criteria") {
      const result = await reviewCriteria({
        cwd: root,
        programId: options.programId,
        ...(options.now ? { now: options.now } : {}),
        onProgress: progress,
      });
      await record(
        stage,
        result.result,
        result.reason,
        `docs(${options.programId}): acceptance criteria`,
      );
      if (result.result === "ABORTED") {
        return finish("FAILED", `Criteria collection failed. ${result.reason ?? ""}`.trim());
      }
      // The one intentional stop, and only when the gate is switched on.
      // Without it the document is produced and the run carries on.
      if (
        config.build.requireCriteriaApproval &&
        result.result === "REVIEW_REQUIRED"
      ) {
        return finish(
          "STOPPED",
          // Resume from criteria, not from build: re-running this stage is
          // free, confirms the approval still matches, and commits it.
          `Review the acceptance criteria in ${result.documentPath}, then approve and resume:\n  program-pipeline criteria ${options.programId} --approve\n  program-pipeline run ${options.programId} --from criteria`,
        );
      }
      continue;
    }

    if (stage === "build") {
      const result = await buildProgram({
        cwd: root,
        programId: options.programId,
        approve: true,
        // The build runner owns its own per-workstream commits.
        ...(commitsEnabled ? {} : { commit: false }),
        ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
        ...(options.verifyRunner ? { verifyRunner: options.verifyRunner } : {}),
        ...(options.now ? { now: options.now } : {}),
        onProgress: progress,
      });
      await record(stage, result.result, result.reason);
      if (result.result !== "COMPLETE") {
        return finish(
          "FAILED",
          `Build ${result.result}. ${result.reason ?? ""} Fix the cause and resume with: program-pipeline run ${options.programId} --from build`.trim(),
        );
      }
      continue;
    }

    // as-built
    const result = await updateAsBuilt({
      cwd: root,
      programId: options.programId,
      ...(options.agentRunner ? { agentRunner: options.agentRunner } : {}),
      onProgress: progress,
    });
    await record(
      stage,
      result.result,
      result.reason,
      `docs(${options.programId}): as-built snapshot`,
    );
    if (result.result === "ABORTED") {
      return finish("FAILED", `Snapshot aborted. ${result.reason ?? ""}`.trim());
    }
  }

  progress(`\nrun ${options.programId} complete`);
  return finish("COMPLETE");
}
