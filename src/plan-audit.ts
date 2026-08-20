import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveValidatorAgent,
  type AgentRunner,
} from "./agent-runner.js";
import { summaryContract } from "./agent-summary.js";
import { identify, haltsConvergence, splitCriterionSubjects, type ClassAnalysis, type IdentifiedFinding } from "./findings.js";
import { loadPipelineConfig } from "./pipeline-config.js";
import {
  appendMemoryEvents,
  type MemoryEventInput,
} from "./program-memory.js";
import { writeReplanReport } from "./replan-report.js";
import { parseExecutionMode, type ExecutionMode } from "./execution-mode.js";
import {
  extractJson,
  parseCriticReply,
  type CriticReply,
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
  criticLogs?: string[];
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

function parseClassAnalyses(value: unknown): {
  analyses: PlanClassAnalysis[];
  errors: string[];
} {
  if (!Array.isArray(value)) {
    return { analyses: [], errors: ["classAnalyses must be an array"] };
  }
  const analyses: PlanClassAnalysis[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null) {
      errors.push(`classAnalyses[entry ${index + 1}]: must be an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const subject = typeof record.subject === "string" ? record.subject.trim() : "";
    const rootCause = typeof record.rootCause === "string" ? record.rootCause.trim() : "";
    const completenessBasis = typeof record.completenessBasis === "string"
      ? record.completenessBasis.trim()
      : "";
    const label = subject
      ? subject
      : `entry ${index + 1}`;
    const affectedSubjects = strings(record.affectedSubjects);
    // Naming a subject as affected is itself the claim it was inspected, so
    // the affected ⊆ checked invariant is repaired by union rather than by
    // demanding a correction retry the model performs mechanically anyway.
    const checkedSubjects = [...new Set([...strings(record.checkedSubjects), ...affectedSubjects])];
    const entryErrors: string[] = [];
    if (!subject) entryErrors.push("subject must be a non-empty string");
    if (record.scope !== "isolated" && record.scope !== "systemic") entryErrors.push("scope must be isolated or systemic");
    if (!rootCause) entryErrors.push("rootCause must be non-empty");
    if (checkedSubjects.length === 0) entryErrors.push("checkedSubjects must contain at least one member");
    if (!completenessBasis) entryErrors.push("completenessBasis must be non-empty");
    if (entryErrors.length > 0) {
      errors.push(`classAnalyses[${label}]: ${entryErrors.join("; ")}`);
      continue;
    }
    // A compound subject ("SC-05/SC-06") splits into one analysis per SC-id;
    // duplicates keep the first occurrence so a split copy never collides
    // with a dedicated entry.
    for (const splitSubject of splitCriterionSubjects(subject)) {
      if (analyses.some((analysis) => analysis.subject === splitSubject)) continue;
      analyses.push({
        subject: splitSubject,
        scope: record.scope as "isolated" | "systemic",
        rootCause,
        affectedSubjects,
        checkedSubjects,
        completenessBasis,
      });
    }
  }
  return { analyses, errors };
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

interface ParsedAuditContract {
  record: Record<string, unknown>;
  criterionAssessments: CriterionAssessment[];
  classAnalyses: PlanClassAnalysis[];
  modeAssessment?: ModeAssessment;
  reply: CriticReply;
}

function parseAuditContract(
  output: string,
  criterionIds: string[],
  executionMode: ExecutionMode,
  requireModeAssessment: boolean,
): { contract?: ParsedAuditContract; errors: string[] } {
  const raw = extractJson(
    output,
    (value) => typeof value === "object" && value !== null &&
      Array.isArray((value as Record<string, unknown>).criterionAssessments) &&
      Array.isArray((value as Record<string, unknown>).findings),
  );
  if (typeof raw !== "object" || raw === null) {
    return { errors: ["response contains no fenced JSON object with criterionAssessments and findings arrays"] };
  }
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  const criterionAssessments = parseAssessments(record.criterionAssessments);
  const assessmentCounts = new Map<string, number>();
  for (const { criterionId } of criterionAssessments) {
    assessmentCounts.set(criterionId, (assessmentCounts.get(criterionId) ?? 0) + 1);
  }
  const missing = criterionIds.filter((id) => !assessmentCounts.has(id));
  const duplicate = [...assessmentCounts].filter(([, count]) => count > 1).map(([id]) => id);
  const unexpected = [...assessmentCounts.keys()].filter((id) => !criterionIds.includes(id));
  if (missing.length > 0) errors.push(`criterionAssessments missing: ${missing.join(", ")}`);
  if (duplicate.length > 0) errors.push(`criterionAssessments duplicated: ${duplicate.join(", ")}`);
  if (unexpected.length > 0) errors.push(`criterionAssessments unexpected: ${unexpected.join(", ")}`);
  if (criterionAssessments.length !== (Array.isArray(record.criterionAssessments) ? record.criterionAssessments.length : 0)) {
    errors.push("one or more criterionAssessments entries are malformed: require criterionId, satisfiable|conflict status, non-empty reason, checkedSubjects, and completenessBasis");
  }

  const modeAssessment = parseModeAssessment(record.modeAssessment);
  if (requireModeAssessment && !modeAssessment) errors.push(`modeAssessment missing or malformed for ${executionMode}`);
  else if (requireModeAssessment && modeAssessment?.mode !== executionMode) errors.push(`modeAssessment.mode must be ${executionMode}, received ${modeAssessment?.mode ?? "missing"}`);

  // parseCriticReply splits compound criterion subjects ("SC-05/SC-06") into
  // one finding per SC-id, so every subject below is already canonical.
  const reply = parseCriticReply(output);
  if (!reply.found) {
    errors.push(`findings contract unreadable: ${reply.protocolFailure?.message ?? "unknown protocol failure"}`);
  }

  const parsedAnalyses = parseClassAnalyses(record.classAnalyses);
  errors.push(...parsedAnalyses.errors);
  const analyzed = new Set(parsedAnalyses.analyses.map(({ subject }) => subject));
  const conflicts = criterionAssessments.filter(({ status }) => status === "conflict");
  const requiredAnalysis = new Set([
    ...reply.findings.filter(haltsConvergence).map(({ subject }) => subject),
    ...conflicts.map(({ criterionId }) => criterionId),
  ]);
  const missingAnalysis = [...requiredAnalysis].filter((subject) => !analyzed.has(subject));
  if (missingAnalysis.length > 0) errors.push(`classAnalyses missing for blocker/major subjects: ${missingAnalysis.join(", ")}`);

  if (errors.length > 0) return { errors };
  return {
    contract: {
      record,
      criterionAssessments,
      classAnalyses: parsedAnalyses.analyses,
      ...(modeAssessment ? { modeAssessment } : {}),
      reply,
    },
    errors: [],
  };
}

function correctionBrief(previous: string, errors: string[]): string {
  return `# Correct the plan-audit response contract

Your repository review is complete. Do not re-run the review, change findings,
or edit files. Re-emit the complete fenced JSON contract and fenced summary,
correcting every deterministic error below:

${errors.map((error) => `- ${error}`).join("\n")}

Requirements:
- Preserve the original semantic judgment.
- Every criterion assessed as conflict has its own classAnalyses entry whose subject is that criterionId, even when another criterion has the same root cause.
- Every blocker/major subject has a classAnalyses entry with the same subject.
- Return every criterion assessment exactly once.

Previous response:

---
${previous}
---

${summaryContract()}`;
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
criterion list), inspect every member, and report all affected members for that
criterion in one finding. Do not patch an instance while leaving its siblings
for later rounds. If the same root cause affects multiple success criteria,
emit one finding and one class analysis per SC-id; never use a compound subject
such as "SC-01 / SC-02" and never orphan a conflicting criterion by choosing
only one canonical SC-id.

For every blocker or major finding, classify it as isolated or systemic and
provide a class analysis with the same subject. checkedSubjects is everything
you inspected; affectedSubjects is the complete subset that needs repair;
completenessBasis explains why no parallel instance was omitted.
Every criterionAssessment with status "conflict" also requires a classAnalysis
whose subject exactly equals that criterionId, whether or not its root cause is
shared with another criterion.

The manifest is the single source of truth for success-criteria text, the
workstream roster, dependencies, and scope. The program document must
reference criteria and workstreams by id without restating their text: flag a
restated copy that contradicts the manifest as a blocker, and a merely
duplicated copy as a minor duplication finding naming the manifest as
canonical. Where repetition is legitimate (architecture prose referencing an
interface, workstreams[].scope entries), checkedSubjects must include every
such copy plus the runtime implementations. A scope entry is not secondary
prose: it is often the only copy an author agent sees. Resolve conditional
set members against the repository; an "only if one exists" member cannot
belong to an asserted-equal set. Distinguish a reconciled disposition from a
token merely appearing in a narrative resolution paragraph.

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
  const runner = options.agentRunner ?? defaultAgentRunner;
  const criticLogs: string[] = [];
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, "-");
  const runId = `${stamp}-${randomUUID().slice(0, 8)}`;
  const logDir = resolve(root, config.build.logDir);
  let prompt = brief(options.programId, criterionIds, executionMode, requireModeAssessment, documents);
  let contract: ParsedAuditContract | undefined;
  let finalErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await runner({ command: agent.command, args: agent.args, prompt, promptMode: agent.promptMode, cwd: root });
    const logPath = join(logDir, `${options.programId}-plan-audit-${runId}-critic-attempt-${attempt}.log`);
    try {
      await mkdir(logDir, { recursive: true });
      await writeFile(logPath, result.output, { encoding: "utf8", flag: "wx" });
      criticLogs.push(logPath);
    } catch (error) {
      progress(`WARNING: could not preserve plan critic response: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.inputError || result.exitCode !== 0) {
      return { result: "ABORTED", reason: `Plan critic${attempt === 2 ? " correction retry" : ""} failed: ${result.inputError ?? result.output.slice(-1000)}. Full response: ${criticLogs.at(-1) ?? "could not be written"}`, agent: label, findings: [], criterionAssessments: [], classAnalyses: [], criteriaPatches: [], criticLogs };
    }
    const parsed = parseAuditContract(result.output, criterionIds, executionMode, requireModeAssessment);
    finalErrors = parsed.errors;
    if (parsed.contract) {
      contract = parsed.contract;
      break;
    }
    if (attempt === 1) {
      progress(`plan critic protocol failure: ${finalErrors.join(" | ")}; retrying once to correct the response contract. Full response: ${criticLogs.at(-1) ?? "could not be written"}`);
      prompt = correctionBrief(result.output, finalErrors);
    }
  }
  if (!contract) {
    return {
      result: "ABORTED",
      reason: `Plan critic response remained invalid after one correction retry: ${finalErrors.join(" | ")}. Full responses: ${criticLogs.join(", ") || "could not be written"}.`,
      agent: label,
      findings: [],
      criterionAssessments: [],
      classAnalyses: [],
      criteriaPatches: [],
      criticLogs,
    };
  }
  const { criterionAssessments, classAnalyses, modeAssessment, reply } = contract;
  // Persist what the audit verified — on every outcome, PASS included. A
  // passed audit used to leave nothing behind, so each replan cycle re-derived
  // the source-grounded criterion analysis from scratch.
  const recordAudit = async (events: MemoryEventInput[]): Promise<void> => {
    try {
      await appendMemoryEvents(
        root,
        options.programId,
        events.map(
          (event) =>
            ({
              ...event,
              at: (options.now ?? (() => new Date()))().toISOString(),
              runId: `plan-audit-${runId}`,
            }) as Parameters<typeof appendMemoryEvents>[2][number],
        ),
      );
    } catch (error) {
      progress(
        `WARNING: could not write program memory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await recordAudit([
    { kind: "run-started", stage: "plan-audit" },
    ...criterionAssessments.map(({ criterionId, status, reason }) => ({
      kind: "criterion-assessed" as const,
      criterionId,
      status,
      reason,
    })),
    ...(modeAssessment
      ? [
          {
            kind: "stage-diagnosis" as const,
            stage: "plan-audit",
            outcome: `execution-mode-${modeAssessment.status}`,
            reason: modeAssessment.reason,
            detail: modeAssessment.evidence.join("; "),
          },
        ]
      : []),
  ]);
  const conflicts = criterionAssessments.filter(({ status }) => status === "conflict");
  const modeFinding = modeAssessment?.status === "inappropriate" ? {
    severity: "blocker" as const,
    category: "scope-structure" as const,
    subject: "execution mode",
    message: modeAssessment.reason,
    evidence: modeAssessment.evidence.map((detail) => ({ kind: "concern" as const, named: "execution mode mismatch", detail })),
    requiresReplan: true,
  } : undefined;
  const identified = [
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
  const findings = [...new Map(identified.map((finding) => [finding.id, finding])).values()];
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
  const missingAnalysis = [...new Set(findings.filter(haltsConvergence).map(({ subject }) => subject).filter((subject) => !analyzed.has(subject)))];
  if (missingAnalysis.length > 0) return { result: "ABORTED", reason: `Plan critic omitted class-wide analysis for: ${missingAnalysis.join(", ")}.`, agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, criticLogs };
  const blocking = findings.filter(haltsConvergence);
  const substantive = reply.requirementsChangeRequested && (reply.criteriaPatches.length === 0 || reply.criteriaPatches.some((patch) => patch.kind === "substantive" || !patch.intentPreserved));
  if (substantive) {
    const humanReason = reply.requirementsChangeReason ?? "The plan audit found a genuine requirements decision.";
    const written = await writeReplanReport(root, options.programId, config, {
      summary: "Plan audit requires a human requirements decision before authoring.",
      replanFindings: blocking,
      relatedFindings: findings,
      checkpointAssessments: [],
      criticSummary: conflicts.map(({ criterionId, reason }) => `${criterionId}: ${reason}`).join("; "),
      criticLogs,
      classAnalyses,
      criteriaPatches: reply.criteriaPatches,
      outcome: "human-required",
      humanDecisionReason: humanReason,
    }, options.now);
    await recordAudit([{ kind: "loop-finished", stage: "plan-audit", outcome: "human-required", result: "HUMAN_REQUIRED", reason: humanReason }]);
    return { result: "HUMAN_REQUIRED", reason: humanReason, agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, replanReport: written.path, criticLogs };
  }
  if (conflicts.length === 0 && blocking.length === 0) {
    await recordAudit([{ kind: "loop-finished", stage: "plan-audit", outcome: "passed", result: "PASSED" }]);
    return { result: "PASSED", agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, ...(modeAssessment ? { modeAssessment } : {}), criticLogs };
  }
  const auditReason = `Plan audit found ${blocking.length} blocker/major finding(s) before authoring.`;
  const written = await writeReplanReport(root, options.programId, config, { summary: auditReason, replanFindings: blocking, relatedFindings: findings, checkpointAssessments: [], criticSummary: conflicts.map(({ criterionId, reason }) => `${criterionId}: ${reason}`).join("; "), criticLogs, classAnalyses, criteriaPatches: reply.criteriaPatches }, options.now);
  await recordAudit([{ kind: "loop-finished", stage: "plan-audit", outcome: "requires-replan", result: "REQUIRES_REPLAN", reason: auditReason }]);
  return { result: "REQUIRES_REPLAN", reason: auditReason, agent: label, findings, criterionAssessments, classAnalyses, criteriaPatches: reply.criteriaPatches, ...(modeAssessment ? { modeAssessment } : {}), replanReport: written.path, criticLogs };
}
