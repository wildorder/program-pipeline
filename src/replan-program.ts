import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveReplannerAgent,
  type AgentRunner,
} from "./agent-runner.js";
import { resolveSummary } from "./agent-summary.js";
import { atomicWriteText } from "./plan-generation.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";
import { replanReportPath } from "./replan-report.js";
import { extractJson, hasArrayKey, type CriteriaPatch } from "./validate-loop.js";
import type { ReplanReport } from "./replan-report.js";

export interface ReplanProgramOptions {
  cwd: string;
  programId: string;
  agentRunner?: AgentRunner;
  onProgress?: (line: string) => void;
}

export interface ReplanProgramResult {
  result: "COMPLETE" | "FAILED" | "ABORTED";
  reason?: string;
  agent?: string;
  generation?: string;
  changedPaths: string[];
}

interface Criterion { id?: unknown; description?: unknown; [key: string]: unknown }

function criteria(manifest: string): Criterion[] {
  const parsed = JSON.parse(manifest) as { successCriteria?: unknown };
  return Array.isArray(parsed.successCriteria) ? parsed.successCriteria as Criterion[] : [];
}

function criteriaChangeAllowed(before: string, after: string, patches: CriteriaPatch[]): boolean {
  const previous = criteria(before);
  const next = criteria(after);
  if (JSON.stringify(previous) === JSON.stringify(next)) return true;
  if (previous.length !== next.length) return false;
  const allowed = new Map(
    patches
      .filter((patch) => patch.kind === "clarification" && patch.intentPreserved)
      .map((patch) => [patch.criterionId, patch]),
  );
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right || left.id !== right.id) return false;
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (typeof left.id !== "string") return false;
    const patch = allowed.get(left.id);
    if (!patch || left.description !== patch.before || right.description !== patch.after) return false;
    const leftRest = { ...left, description: undefined };
    const rightRest = { ...right, description: undefined };
    if (JSON.stringify(leftRest) !== JSON.stringify(rightRest)) return false;
  }
  return true;
}

function brief(programId: string, report: string, program: string, manifest: string): string {
  return `You are the headless replanner for program ${programId}.

This is a REPLAN ONLY operation. Read the replan report and repair the plan's
workstream boundaries, dependency graph, taskFile paths, and sequencing so the
reported structural defects are resolved.

Hard rules:
- Do not change user requirements. Success criteria may change only through an
  exact intent-preserving criteriaPatches entry in the report.
- Do not edit source code, tests, AGENTS.md, vision, or any file outside the
  program document and manifest.
- Preserve landed work and preserve superseded task specs as historical files.
- Preserve the selected execution mode unless the report identifies a mode-fit
  defect. When it does, switch modes without changing requirements and update
  program.executionModeReason with the concrete causal evidence. Atomic mode
  must contain exactly one whole-program workstream; orchestrated mode must
  justify its checkpoint graph. Approximate token-band estimates alone never
  force a mode change.
- Set program.planGeneration to a new unique value.
- Resolve every blocker/major in both replanFindings and relatedFindings.
- For every classAnalyses entry, inspect the whole checked set and repair the
  root cause across every affected subject. Do not fix only the example that
  triggered the report.
- Write a concise fenced \`summary\` block ending with REPLAN_COMPLETE.
- Also return one fenced JSON object with resolutionProofs. Each proof names a
  finding subject, changed artifacts, every analogous subject checked, and why
  that set is exhaustive:
  { "resolutionProofs": [{ "subject": "SC-03", "changedPaths": ["docs/programs/x-program.md"], "checkedSubjects": ["audit", "surface bind"], "completenessBasis": "complete command list in SC-03" }] }

Replan report:
---
${report}
---
Current program document:
---
${program}
---
Current manifest:
---
${manifest}
---`;
}

export async function replanProgram(options: ReplanProgramOptions): Promise<ReplanProgramResult> {
  const root = resolve(options.cwd);
  const config: PipelineConfig = await loadPipelineConfig(root);
  const agent = resolveReplannerAgent(config);
  if (!agent) return { result: "ABORTED", reason: "No replanner agent is configured.", changedPaths: [] };
  const reportPath = replanReportPath(root, options.programId);
  const manifestPath = join(root, "docs", "programs", `${options.programId}-manifest.json`);
  const programPath = join(root, "docs", "programs", `${options.programId}-program.md`);
  const [report, beforeManifest, beforeProgram] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(programPath, "utf8"),
  ]);
  const parsedReport = JSON.parse(report) as Partial<ReplanReport>;
  const runner = options.agentRunner ?? defaultAgentRunner;
  const progress = options.onProgress ?? (() => {});
  const label = describeAgent(agent);
  progress(`replanner: ${label}`);
  const result = await runner({
    command: agent.command,
    args: agent.args,
    prompt: brief(options.programId, report, beforeProgram, beforeManifest),
    promptMode: agent.promptMode,
    cwd: root,
  });
  if (result.inputError || result.exitCode !== 0) {
    return { result: "FAILED", reason: `Replanner failed: ${result.inputError ?? result.output.slice(-1000)}`, agent: label, changedPaths: [] };
  }
  if (!/REPLAN_COMPLETE/u.test(result.output)) {
    return {
      result: "FAILED",
      reason: "Replanner did not return the required REPLAN_COMPLETE contract.",
      agent: label,
      changedPaths: [],
    };
  }
  const proofBlock = extractJson(result.output, (value) => hasArrayKey(value, "resolutionProofs"));
  const proofs = typeof proofBlock === "object" && proofBlock !== null
    ? (proofBlock as { resolutionProofs?: unknown }).resolutionProofs
    : undefined;
  const validProofSubjects = new Set(
    Array.isArray(proofs)
      ? proofs.flatMap((proof) => {
          if (typeof proof !== "object" || proof === null) return [];
          const entry = proof as Record<string, unknown>;
          return typeof entry.subject === "string" &&
            Array.isArray(entry.changedPaths) && entry.changedPaths.length > 0 &&
            Array.isArray(entry.checkedSubjects) && entry.checkedSubjects.length > 0 &&
            typeof entry.completenessBasis === "string" && entry.completenessBasis.trim() !== ""
            ? [entry.subject]
            : [];
        })
      : [],
  );
  const proofObligations = new Set([
    ...(parsedReport.replanFindings ?? []).map(({ subject }) => subject),
    ...(parsedReport.relatedFindings ?? [])
      .filter(({ severity }) => severity === "blocker" || severity === "major")
      .map(({ subject }) => subject),
    ...(parsedReport.classAnalyses ?? []).map(({ subject }) => subject),
  ]);
  const missingProofs = [...proofObligations].filter((subject) => !validProofSubjects.has(subject));
  if (missingProofs.length > 0) {
    return {
      result: "FAILED",
      reason: `Replanner omitted class-wide resolution proof for: ${missingProofs.join(", ")}.`,
      agent: label,
      changedPaths: [],
    };
  }
  const [afterManifest, afterProgram] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(programPath, "utf8"),
  ]);
  const parsed = JSON.parse(afterManifest) as { program?: { planGeneration?: unknown } };
  if (!criteriaChangeAllowed(beforeManifest, afterManifest, parsedReport.criteriaPatches ?? [])) {
    return {
      result: "FAILED",
      reason: "Replanner changed success criteria; automatic replanning is blocked. A human requirements decision is required.",
      agent: label,
      changedPaths: [],
    };
  }
  let generation = typeof parsed.program?.planGeneration === "string" ? parsed.program.planGeneration : "";
  if (!generation) {
    parsed.program = { ...(parsed.program ?? {}), planGeneration: `auto-${new Date().toISOString()}-${randomUUID().slice(0, 8)}` };
    generation = parsed.program.planGeneration as string;
    await atomicWriteText(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  const finalManifest = await readFile(manifestPath, "utf8");
  if (finalManifest === beforeManifest && afterProgram === beforeProgram) {
    return { result: "FAILED", reason: "Replanner made no changes to the program document or manifest.", agent: label, generation, changedPaths: [] };
  }
  const summary = resolveSummary(result.output);
  progress(`replanner complete: ${summary.text || "plan artifacts updated"}`);
  return { result: "COMPLETE", agent: label, generation, changedPaths: [programPath, manifestPath] };
}
