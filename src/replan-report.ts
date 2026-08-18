import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { convergenceInputHash } from "./convergence-receipt.js";
import type { IdentifiedFinding } from "./findings.js";
import type { PipelineConfig } from "./pipeline-config.js";
import type { CheckpointAssessment } from "./validate-loop.js";

export const REPLAN_REPORT_VERSION = 1;

export interface ReplanReport {
  schemaVersion: typeof REPLAN_REPORT_VERSION;
  programId: string;
  generatedAt: string;
  inputHash: string;
  outcome: "requires-replan";
  summary: string;
  replanFindings: IdentifiedFinding[];
  relatedFindings: IdentifiedFinding[];
  checkpointAssessments: CheckpointAssessment[];
  criticSummary: string;
  criticLogs: string[];
  planningInstruction: string;
}

export function replanReportPath(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-replan.json`);
}

/** Remove the generated handoff once the replacement plan converges. */
export async function clearReplanReport(
  root: string,
  programId: string,
): Promise<void> {
  await rm(replanReportPath(root, programId), { force: true });
}

function portableLogPath(root: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const candidate = relative(resolve(root), path);
  return candidate.startsWith("..") ? path : candidate.replaceAll("\\", "/");
}

export async function writeReplanReport(
  root: string,
  programId: string,
  config: PipelineConfig,
  input: {
    summary: string;
    replanFindings: IdentifiedFinding[];
    relatedFindings: IdentifiedFinding[];
    checkpointAssessments: CheckpointAssessment[];
    criticSummary: string;
    criticLogs: string[];
  },
  now: () => Date = () => new Date(),
): Promise<{ path: string; report: ReplanReport }> {
  const path = replanReportPath(root, programId);
  const report: ReplanReport = {
    schemaVersion: REPLAN_REPORT_VERSION,
    programId,
    generatedAt: now().toISOString(),
    inputHash: await convergenceInputHash(root, programId, config),
    outcome: "requires-replan",
    summary: input.summary,
    replanFindings: input.replanFindings,
    relatedFindings: input.relatedFindings,
    checkpointAssessments: input.checkpointAssessments,
    criticSummary: input.criticSummary,
    criticLogs: input.criticLogs.map((log) => portableLogPath(root, log)),
    planningInstruction: `Run /plan-program ${programId}. The planning skill must read this report and resolve every replanFindings entry before replacing the program plan and manifest.`,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { path, report };
}
