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

function hashRequirements(manifest: string): string {
  const parsed = JSON.parse(manifest) as { successCriteria?: unknown };
  return JSON.stringify(parsed.successCriteria ?? null);
}

function brief(programId: string, report: string, program: string, manifest: string): string {
  return `You are the headless replanner for program ${programId}.

This is a REPLAN ONLY operation. Read the replan report and repair the plan's
workstream boundaries, dependency graph, taskFile paths, and sequencing so the
reported structural defects are resolved.

Hard rules:
- Do not change user requirements or success criteria.
- Do not edit source code, tests, AGENTS.md, vision, or any file outside the
  program document and manifest.
- Preserve landed work and preserve superseded task specs as historical files.
- Set program.planGeneration to a new unique value.
- Write a concise fenced \`summary\` block ending with REPLAN_COMPLETE.

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
  const [afterManifest, afterProgram] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(programPath, "utf8"),
  ]);
  const parsed = JSON.parse(afterManifest) as { program?: { planGeneration?: unknown } };
  if (hashRequirements(beforeManifest) !== hashRequirements(afterManifest)) {
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
