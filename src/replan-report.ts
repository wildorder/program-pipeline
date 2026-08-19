import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ClassAnalysis, IdentifiedFinding } from "./findings.js";
import type { PipelineConfig } from "./pipeline-config.js";
import type { CheckpointAssessment } from "./validate-loop.js";
import type { CriteriaPatch } from "./validate-loop.js";
import { atomicWriteText } from "./plan-generation.js";

export const REPLAN_REPORT_VERSION = 3;

export interface ReplanResolutionProof {
  subject: string;
  changedPaths: string[];
  dispositions: Array<{
    subject: string;
    disposition: "fixed" | "already-correct";
    evidence: Array<{ path: string; detail: string }>;
  }>;
  completenessBasis: string;
}

export interface ReplanAttempt {
  attemptedAt: string;
  attempt: number;
  agent: string;
  outcome: "rejected" | "accepted";
  reason: string;
  failedSubjects: string[];
  /** False on rejection means canonical artifacts were restored transactionally. */
  artifactsLeftOnDisk: boolean;
  /** Parsed proof payload, including incomplete proofs on rejected attempts. */
  resolutionProofs?: ReplanResolutionProof[];
}

export interface ReplanReport {
  schemaVersion: typeof REPLAN_REPORT_VERSION;
  programId: string;
  generatedAt: string;
  inputHash: string;
  outcome: "requires-replan";
  summary: string;
  replanFindings: IdentifiedFinding[];
  relatedFindings: IdentifiedFinding[];
  /** Root-cause closure obligations discovered by the plan/spec critic. */
  classAnalyses: ClassAnalysis[];
  /** Intent-preserving criterion repairs the replanner is allowed to apply. */
  criteriaPatches: CriteriaPatch[];
  checkpointAssessments: CheckpointAssessment[];
  criticSummary: string;
  criticLogs: string[];
  planningInstruction: string;
  /** Archived report this handoff superseded, when one existed. */
  supersedes?: string;
  /** Most recent automatic-replanner attempt. Read rejected attempts first. */
  lastAttempt?: ReplanAttempt;
  /** Bounded diagnostic history so a later planner sees every failed retry. */
  attemptHistory?: ReplanAttempt[];
}

export function replanReportPath(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-replan.json`);
}

export function replanHistoryDir(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-replan-history`);
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

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "<missing>";
  }
}

/** Hash the exact canonical planning inputs, including absent task specs. */
export async function replanInputHash(
  rootInput: string,
  programId: string,
  config: PipelineConfig,
): Promise<string> {
  const root = resolve(rootInput);
  const manifestPath = join(root, "docs", "programs", `${programId}-manifest.json`);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    workstreams?: Array<{ id?: unknown; taskFile?: unknown }>;
  };
  const entries: Array<[string, string]> = [
    ["program", await readFile(join(root, "docs", "programs", `${programId}-program.md`), "utf8")],
    ["manifest", manifestText],
  ];
  for (const path of ["AGENTS.md", config.visionPath, ...config.contextDocs]) {
    entries.push([path, await optionalText(resolve(root, path))]);
  }
  for (const workstream of manifest.workstreams ?? []) {
    if (typeof workstream.taskFile !== "string") continue;
    entries.push([
      `spec:${typeof workstream.id === "string" ? workstream.id : "unknown"}:${workstream.taskFile}`,
      await optionalText(resolve(root, workstream.taskFile)),
    ]);
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function recordReplanAttempt(
  path: string,
  attempt: ReplanAttempt,
): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as ReplanReport;
  const history = [...(parsed.attemptHistory ?? []), attempt].slice(-10);
  await atomicWriteText(path, `${JSON.stringify({
    ...parsed,
    schemaVersion: REPLAN_REPORT_VERSION,
    lastAttempt: attempt,
    attemptHistory: history,
  }, null, 2)}\n`);
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
    classAnalyses?: ClassAnalysis[];
    criteriaPatches?: CriteriaPatch[];
  },
  now: () => Date = () => new Date(),
): Promise<{ path: string; report: ReplanReport }> {
  const path = replanReportPath(root, programId);
  let supersedes: string | undefined;
  try {
    await access(path);
    const archive = join(
      replanHistoryDir(root, programId),
      `${now().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}.json`,
    );
    await mkdir(dirname(archive), { recursive: true });
    await rename(path, archive);
    supersedes = archive.replace(`${resolve(root)}\\`, "").replaceAll("\\", "/");
  } catch {
    // No prior report, or it disappeared between access and rename.
  }
  const inputHash = await replanInputHash(root, programId, config);
  const report: ReplanReport = {
    schemaVersion: REPLAN_REPORT_VERSION,
    programId,
    generatedAt: now().toISOString(),
    inputHash,
    outcome: "requires-replan",
    summary: input.summary,
    replanFindings: input.replanFindings,
    relatedFindings: input.relatedFindings,
    classAnalyses: input.classAnalyses ?? [],
    criteriaPatches: input.criteriaPatches ?? [],
    checkpointAssessments: input.checkpointAssessments,
    criticSummary: input.criticSummary,
    criticLogs: input.criticLogs.map((log) => portableLogPath(root, log)),
    planningInstruction: `Run /plan-program ${programId}. Read lastAttempt first when present and prioritize every failedSubjects entry. Resolve every replanFindings and blocker/major relatedFindings entry. For each classAnalyses entry, close the root-cause class by reconciling every checkedSubjects member with an explicit fixed or already-correct disposition and concrete evidence; naming a member in narrative prose is not proof. Re-check every workstreams[].scope copy affected by a criterion or interface repair. Apply only the explicitly listed intent-preserving criteriaPatches; any other requirements change needs a human decision.`,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteText(path, `${JSON.stringify(report, null, 2)}\n`);
  return { path, report };
}
