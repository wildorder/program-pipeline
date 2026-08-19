import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveValidatorAgent,
  type AgentRunner,
} from "./agent-runner.js";
import { summaryContract } from "./agent-summary.js";
import { identify, haltsConvergence, type ClassAnalysis, type IdentifiedFinding } from "./findings.js";
import { loadPipelineConfig } from "./pipeline-config.js";
import { writeReplanReport } from "./replan-report.js";
import { parseExecutionMode, type ExecutionMode } from "./execution-mode.js";
import {
  extractJson,
  parseCriticReply,
  type CriteriaPatch,
} from "./validate-loop.js";

export type PlanClassAnalysis = ClassAnalysis;

export interface CriterionAssessment {
  criterionId: string;
  status: "satisfiable" | "conflict";
  reason: string;
  checkedSubjects: string[];
  completenessBasis: string;
}

export interface ModeAssessment {
  mode: ExecutionMode;
  status: "appropriate" | "inappropriate";
  reason: string;
  evidence: string[];
}

export interface PlanAuditResult {
  result: "PASSED" | "REQUIRES_REPLAN" | "HUMAN_REQUIRED" | "ABORTED";
  reason?: string;
  agent?: string;
  findings: IdentifiedFinding[];
  criterionAssessments: CriterionAssessment[];
  classAnalyses: PlanClassAnalysis[];
  criteriaPatches: CriteriaPatch[];
  modeAssessment?: ModeAssessment;
  replanReport?: string;
}

export interface PlanAuditOptions {
  cwd: string;
  programId: string;
  agentRunner?: AgentRunner;
  now?: () => Date;
  onProgress?: (line: string) => void;
  /** Effective mode, including a CLI override when one was supplied. */
  executionMode?: ExecutionMode;
  /** Whether mode fit is part of this audit (false for legacy manifests). */
  assessExecutionMode?: boolean;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];

function parseAssessments(value: unknown): CriterionAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const checkedSubjects = strings(record.checkedSubjects);
    if (
      typeof record.criterionId !== "string" ||
      (record.status !== "satisfiable" && record.status !== "conflict") ||
      typeof record.reason !== "string" ||
      record.reason.trim() === "" ||
      checkedSubjects.length === 0 ||
      typeof record.completenessBasis !== "string" ||
      record.completenessBasis.trim() === ""
    ) return [];
    return [{
      criterionId: record.criterionId,
      status: record.status,
      reason: record.reason.trim(),
      checkedSubjects,
      completenessBasis: record.completenessBasis.trim(),
    }];
  });
}

function parseClassAnalyses(value: unknown): PlanClassAnalysis[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const affectedSubjects = strings(record.affectedSubjects);
    const checkedSubjects = strings(record.checkedSubjects);
    if (
      typeof record.subject !== "string" || record.subject.trim() === "" ||
      (record.scope !== "isolated" && record.scope !== "systemic") ||
      typeof record.rootCause !== "string" || record.rootCause.trim() === "" ||
      checkedSubjects.length === 0 ||
      typeof record.completenessBasis !== "string" || record.completenessBasis.trim() === ""
    ) return [];
    return [{
      subject: record.subject.trim(),
      scope: record.scope,
      rootCause: record.rootCause.trim(),
      affectedSubjects,
      checkedSubjects,
      completenessBasis: record.completenessBasis.trim(),
    }];
  });
}

function parseModeAssessment(value: unknown): ModeAssessment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const evidence = strings(record.evidence);
  if (
    typeof record.mode !== "string" ||
    (record.status !== "appropriate" && record.status !== "inappropriate") ||
    typeof record.reason !== "string" || record.reason.trim() === "" ||
    evidence.length === 0
  ) return undefined;
  let mode: ExecutionMode;
  try { mode = parseExecutionMode(record.mode); } catch { return undefined; }
  return { mode, status: record.status, reason: record.reason.trim(), evidence };
}

function brief(
  programId: string,
  criterionIds: string[],
  executionMode: ExecutionMode,
  requireModeAssessment: boolean,
  documents: Array<{ label: string; content: string }>,
): string {
  return `# Audit the executable plan for ${programId}

You are the independent plan critic. This runs BEFORE workstream specs are
authored. Do not edit files. Inspect the repository source when the plan names
existing commands, signatures, routes, schemas, or interfaces; prose intent is
not evidence that an existing API can express a criterion.

Review the whole plan, not one counterexample. When a rule or success criterion
applies to a list or conceptual family, enumerate the complete family from a
canonical source (registry, manifest, exported union, route table, or explicit
criterion list), inspect every member, and report all affected members in one
finding. Do not patch an instance while leaving its siblings for later rounds.

For every blocker or major finding, classify it as isolated or systemic and
provide a class analysis with the same subject. checkedSubjects is everything
you inspected; affectedSubjects is the complete subset that needs repair;
completenessBasis explains why no parallel instance was omitted.

Assess every success criterion exactly once: ${criterionIds.join(", ") || "(none)"}.
Each assessment must name the concrete commands/interfaces/paths checked and
the canonical basis that makes that set exhaustive. A criterion is in conflict
when the current plan cannot implement it against the actual repository.

Use requirementsChangeRequested only for a genuine user-intent decision. An
intent-preserving wording repair belongs in criteriaPatches as a clarification.

The selected execution mode is ${executionMode}. ${requireModeAssessment
    ? `Assess whether that mode fits the causal structure of this plan. Atomic is
appropriate only when the whole change is one cohesive agent working set and
one green checkpoint. Orchestrated requires positive evidence such as a
physically impossible single context, necessary parallel independent work,
independently deployable boundaries, or an expand -> migrate -> contract
migration. Approximate token estimates near a threshold are advisory and are
not evidence by themselves. Mark an ill-fitting mode inappropriate.`
    : `This is a legacy manifest with no declared mode; preserve its compatible
orchestrated routing and do not grade mode selection in this audit.`}

## Output

Reply with one fenced JSON object:

\`\`\`json
{
  "criterionAssessments": [{
    "criterionId": "SC-01", "status": "satisfiable" | "conflict",
    "reason": "source-grounded conclusion", "checkedSubjects": ["command A"],
    "completenessBasis": "registry or explicit list used to close the set"
  }],
  ${requireModeAssessment ? `"modeAssessment": {
    "mode": "${executionMode}", "status": "appropriate" | "inappropriate",
    "reason": "causal conclusion", "evidence": ["specific plan/repository evidence"]
  },` : ""}
  "findings": [{
    "severity": "blocker" | "major" | "minor", "category": "acceptance-criteria",
    "subject": "SC-01", "message": "complete defect", "evidence": [
      { "kind": "concern", "named": "signature mismatch", "detail": "command A" }
    ], "requiresReplan": true
  }],
  "classAnalyses": [{
    "subject": "SC-01", "scope": "systemic", "rootCause": "one conceptual rule spans incompatible API shapes",
    "affectedSubjects": ["command A"], "checkedSubjects": ["command A", "command B"],
    "completenessBasis": "all members of the canonical command registry"
  }],
  "requirementsChangeRequested": false,
  "requirementsChangeReason": "",
  "criteriaPatches": []
}
\`\`\`

${documents.map(({ label, content }) => `## ${label}\n\n\`\`\`\n${content}\n\`\`\``).join("\n\n")}

${summaryContract()}`;
}

export async function auditPlan(options: PlanAuditOptions): Promise<PlanAuditResult> {
  const root = resolve(options.cwd);
  const progress = options.onProgress ?? (() => {});
  const config = await loadPipelineConfig(root);
  const agent = resolveValidatorAgent(config);
  if (!agent) return { result: "ABORTED", reason: "No validatorAgent is configured for plan audit.", findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
  const programPath = join(root, "docs", "programs", `${options.programId}-program.md`);
  const manifestPath = join(root, "docs", "programs", `${options.programId}-manifest.json`);
  let program: string;
  let manifest: string;
  try {
    [program, manifest] = await Promise.all([readFile(programPath, "utf8"), readFile(manifestPath, "utf8")]);
  } catch (error) {
    return { result: "ABORTED", reason: error instanceof Error ? error.message : String(error), findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
  }
  const parsedManifest = JSON.parse(manifest) as {
    program?: { executionMode?: unknown };
    successCriteria?: Array<{ id?: unknown }>;
  };
  let declaredMode: ExecutionMode | undefined;
  if (typeof parsedManifest.program?.executionMode === "string") {
    try {
      declaredMode = parseExecutionMode(parsedManifest.program.executionMode);
    } catch (error) {
      return { result: "ABORTED", reason: error instanceof Error ? error.message : String(error), findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
    }
  }
  const executionMode = options.executionMode ?? declaredMode ?? "orchestrated";
  const requireModeAssessment = options.assessExecutionMode ??
    (options.executionMode !== undefined || declaredMode !== undefined);
  const criterionIds = (parsedManifest.successCriteria ?? []).flatMap(({ id }) => typeof id === "string" ? [id] : []);
  const documents = [{ label: "Program document", content: program }, { label: "Manifest", content: manifest }];
  for (const path of ["AGENTS.md", config.visionPath, ...config.contextDocs]) {
    try { documents.push({ label: path, content: await readFile(resolve(root, path), "utf8") }); } catch { /* optional context */ }
  }
  const label = describeAgent(agent);
  progress(`plan critic: ${label}`);
  const result = await (options.agentRunner ?? defaultAgentRunner)({ command: agent.command, args: agent.args, prompt: brief(options.programId, criterionIds, executionMode, requireModeAssessment, documents), promptMode: agent.promptMode, cwd: root });
  if (result.inputError || result.exitCode !== 0) return { result: "ABORTED", reason: `Plan critic failed: ${result.inputError ?? result.output.slice(-1000)}`, agent: label, findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
  const raw = extractJson(result.output, (value) => typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).criterionAssessments) && Array.isArray((value as Record<string, unknown>).findings));
  if (typeof raw !== "object" || raw === null) return { result: "ABORTED", reason: "Plan critic response did not match the required criterion-assessment contract.", agent: label, findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
  const record = raw as Record<string, unknown>;
  const modeAssessment = parseModeAssessment(record.modeAssessment);
  if (requireModeAssessment && (!modeAssessment || modeAssessment.mode !== executionMode)) {
    return { result: "ABORTED", reason: `Plan critic omitted the required ${executionMode} mode assessment.`, agent: label, findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [] };
  }
  const criterionAssessments = parseAssessments(record.criterionAssessments);
  const assessmentIds = new Set(criterionAssessments.map(({ criterionId }) => criterionId));
  const missing = criterionIds.filter((id) => !assessmentIds.has(id));
  const extra = criterionAssessments.filter(({ criterionId }) => !criterionIds.includes(criterionId)).map(({ criterionId }) => criterionId);
  if (missing.length > 0 || extra.length > 0 || criterionAssessments.length !== criterionIds.length) return { result: "ABORTED", reason: `Plan critic criterion coverage is incomplete (missing: ${missing.join(", ") || "none"}; unexpected/duplicate: ${extra.join(", ") || "none"}).`, agent: label, findings: [], criterionAssessments, classAnalyses: [], criteriaPatches: [] };
  const reply = parseCriticReply(result.output);
  const conflicts = criterionAssessments.filter(({ status }) => status === "conflict");
  const modeFinding = modeAssessment?.status === "inappropriate" ? {
    severity: "blocker" as const,
    category: "scope-structure" as const,
    subject: "execution mode",
    message: modeAssessment.reason,
    evidence: modeAssessment.evidence.map((detail) => ({ kind: "concern" as const, named: "execution mode mismatch", detail })),
    requiresReplan: true,
  } : undefined;
  const findings = [
    ...reply.findings,
    ...(modeFinding ? [modeFinding] : []),
    ...conflicts
      .filter(({ criterionId }) => !reply.findings.some(({ subject }) => subject === criterionId))
      .map(({ criterionId, reason }) => ({
        severity: "blocker" as const,
        category: "acceptance-criteria" as const,
        subject: criterionId,
        message: reason,
        evidence: [{ kind: "concern" as const, named: "criterion conflicts with repository reality", detail: criterionId }],
        requiresReplan: true,
      })),
  ].map(identify);
  const classAnalyses = parseClassAnalyses(record.classAnalyses);
  if (modeFinding && !classAnalyses.some(({ subject }) => subject === "execution mode")) {
    classAnalyses.push({
      subject: "execution mode",
      scope: "isolated",
      rootCause: modeAssessment?.reason ?? "selected execution mode does not fit the plan",
      affectedSubjects: [executionMode],
      checkedSubjects: modeAssessment?.evidence ?? [executionMode],
      completenessBasis: "the plan's complete execution topology and checkpoint structure",
    });
  }
  const analyzed = new Set(classAnalyses.map(({ subject }) => subject));
  const missingAnalysis = findings.filter(haltsConvergence).filter(({ subject }) => !analyzed.has(subject));
  if (missingAnalysis.length > 0) return { result: "ABORTED", reason: `Plan critic omitted class-wide analysis for: ${missingAnalysis.map(({ subject }) => subject).join(", ")}.`, agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches };
  const substantive = reply.requirementsChangeRequested && (reply.criteriaPatches.length === 0 || reply.criteriaPatches.some((patch) => patch.kind === "substantive" || !patch.intentPreserved));
  if (substantive) return { result: "HUMAN_REQUIRED", reason: reply.requirementsChangeReason ?? "The plan audit found a genuine requirements decision.", agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches };
  const blocking = findings.filter(haltsConvergence);
  if (conflicts.length === 0 && blocking.length === 0) return { result: "PASSED", agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, ...(modeAssessment ? { modeAssessment } : {}) };
  const written = await writeReplanReport(root, options.programId, config, { summary: `Plan audit found ${blocking.length} blocker/major finding(s) before authoring.`, replanFindings: blocking, relatedFindings: findings, checkpointAssessments: [], criticSummary: conflicts.map(({ criterionId, reason }) => `${criterionId}: ${reason}`).join("; "), criticLogs: [], classAnalyses, criteriaPatches: reply.criteriaPatches }, options.now);
  return { result: "REQUIRES_REPLAN", reason: `Plan audit found ${blocking.length} blocker/major finding(s) before authoring.`, agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, ...(modeAssessment ? { modeAssessment } : {}), replanReport: written.path };
}
