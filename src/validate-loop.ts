import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveAuthorAgent,
  resolveValidatorAgent,
  tail,
  type AgentRunner,
} from "./agent-runner.js";
import {
  resolveSummary,
  summaryLine,
  type AgentSummary,
} from "./agent-summary.js";
import { writeConvergenceReceipt } from "./convergence-receipt.js";
import {
  FINDING_CATEGORIES,
  fingerprint,
  haltsConvergence,
  identify,
  sortBySeverity,
  type Evidence,
  type ClassAnalysis,
  type Finding,
  type FindingCategory,
  type IdentifiedFinding,
  type Severity,
} from "./findings.js";
import {
  loadPipelineConfig,
  MAX_VALIDATE_ROUNDS,
  type AgentConfig,
  type PipelineConfig,
} from "./pipeline-config.js";
import { applySeverityPolicy } from "./severity-policy.js";
import { clearReplanReport, writeReplanReport } from "./replan-report.js";
import { validateWorkstreams } from "./validate.js";
import {
  composeCriticCorrectionBrief,
  composeCriticBrief,
  composeWriterBrief,
  loadBriefSources,
  type RoundContext,
} from "./validator-brief.js";

/**
 * `converged`      — a round produced no new blocker or major findings.
 * `cap-reached`    — the round cap ran out with findings still open.
 * `requires-replan`— a structural defect no spec edit can fix; the loop stops
 *                    immediately and refers the program back to planning.
 * `aborted`        — the loop could not run (missing config, agent failure).
 */
export type LoopOutcome =
  | "converged"
  | "cap-reached"
  | "requires-replan"
  | "aborted";

export interface Disagreement {
  finding: IdentifiedFinding;
  reason: string;
  /** Rounds in which the critic raised it and the writer declined it. */
  rounds: number[];
}

export interface RoundRecord {
  round: number;
  critic: string;
  writer?: string;
  scoped: boolean;
  scopedTo?: string[];
  raised: number;
  fresh: number;
  applied: number;
  rejected: number;
  /**
   * What each agent said it did, verbatim. The findings list records *what*
   * the critic flagged; this is the only place its reasoning survives — the
   * parser keeps the structured block and discards everything around it.
   */
  criticSummary?: string;
  writerSummary?: string;
}

/** Which agent held which role, so the choice is visible without reading source. */
export interface ResolvedAgents {
  author: string;
  validator: string;
  /** No `authorAgent` was configured, so the build agent was borrowed. */
  borrowedBuildAgent: boolean;
}

export interface ValidateLoopResult {
  programId: string;
  outcome: LoopOutcome;
  /** The gate verdict, decided independently of why the loop stopped. */
  result: "PASSED" | "FAILED";
  reason?: string;
  agents?: ResolvedAgents;
  strict: boolean;
  rounds: RoundRecord[];
  findings: IdentifiedFinding[];
  openDisagreements: Disagreement[];
  replanFindings: IdentifiedFinding[];
  /** Written only after the complete semantic and mechanical gate passes. */
  convergenceReceipt?: string;
  /** Full critic responses, including protocol-repair attempts. */
  criticLogs: string[];
  /** Durable handoff consumed by plan-program after requires-replan. */
  replanReport?: string;
  /** Critic says the user's requirements need a human decision. */
  requirementsChangeRequested?: boolean;
}

export interface ValidateLoopOptions {
  cwd: string;
  programId: string;
  rounds?: number;
  strict?: boolean;
  agentRunner?: AgentRunner;
  onProgress?: (line: string) => void;
  now?: () => Date;
  /** Explicitly accept unresolved non-blocking semantic findings after the round cap. */
  allowSemanticRisks?: boolean;
}

export type CriticProtocolFailureKind =
  | "missing-json"
  | "invalid-json"
  | "contract-mismatch";

export interface CriticProtocolFailure {
  kind: CriticProtocolFailureKind;
  message: string;
}

interface JsonExtraction {
  value?: unknown;
  failure?: CriticProtocolFailure;
}

function balancedObjectCandidates(output: string): string[] {
  const candidates: string[] = [];
  // Agent CLIs can stream echoed prompts, tool output, and incomplete source
  // snippets before the final response. An unmatched brace in that transcript
  // must not absorb a later valid answer, so evaluate every JSON-looking `{`
  // independently instead of carrying one global depth through the output.
  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== "{") continue;
    let first = start + 1;
    while (/\s/u.test(output[first] ?? "")) first += 1;
    if (output[first] !== '"' && output[first] !== "}") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(output.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractJsonDetailed(
  output: string,
  accept: (value: unknown) => boolean,
): JsonExtraction {
  const fences = [...output.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/gu)]
    .filter((match) => {
      const language = (match[1] ?? "").trim().toLowerCase();
      return language === "" || language === "json";
    })
    .map((match) => match[2] ?? "");
  const candidates = [...fences, ...balancedObjectCandidates(output)];
  let parsedWrongShape = false;
  let lastParseError: string | undefined;
  for (const candidate of candidates.reverse()) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (accept(value)) return { value };
      parsedWrongShape = true;
    } catch (error) {
      lastParseError ??= jsonError(error);
    }
  }
  if (lastParseError !== undefined) {
    return {
      failure: {
        kind: "invalid-json",
        message: `JSON was present but malformed: ${lastParseError}`,
      },
    };
  }
  if (parsedWrongShape) {
    return {
      failure: {
        kind: "contract-mismatch",
        message: 'JSON parsed, but no object contained the required "findings" array.',
      },
    };
  }
  return {
    failure: {
      kind: "missing-json",
      message: "No JSON object was present in the critic response.",
    },
  };
}

/**
 * Model replies wrap JSON in prose and fences. Scan fenced blocks from the
 * last backwards and return the first that parses **and** matches `accept`,
 * else the last balanced brace span.
 *
 * The predicate is not optional in practice, and leaving it out was a real
 * defect. "Last parseable fenced block" silently picks the wrong one the
 * moment a reply contains any other JSON after its answer — a critic quoting
 * a manifest fragment as evidence, say. The parse then finds no `findings`
 * key, reports zero findings, and the loop reads that as a clean round and
 * returns PASSED. A validation gate that fails open is worse than one that
 * fails, so callers state the shape they want and a reply that never
 * produces it is a protocol failure, not a clean bill of health.
 */
export function extractJson(
  output: string,
  accept: (value: unknown) => boolean = () => true,
): unknown {
  return extractJsonDetailed(output, accept).value;
}

/** True when `value` is an object whose `key` is an array. */
export function hasArrayKey(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>)[key])
  );
}

const SEVERITIES = new Set<Severity>(["blocker", "major", "minor", "advisory"]);
const CATEGORIES = new Set<string>(FINDING_CATEGORIES);

function coerceEvidence(raw: unknown): Evidence[] {
  if (!Array.isArray(raw)) return [];
  const evidence: Evidence[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.kind === "location" && typeof record.file === "string") {
      const startLine = Number(record.startLine);
      evidence.push({
        kind: "location",
        file: record.file,
        startLine: Number.isFinite(startLine) ? startLine : 1,
        ...(Number.isFinite(Number(record.endLine))
          ? { endLine: Number(record.endLine) }
          : {}),
      });
    } else if (record.kind === "concern" && typeof record.named === "string") {
      evidence.push({
        kind: "concern",
        named: record.named,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      });
    } else if (
      record.kind === "measurement" &&
      (record.metric === "lineCount" || record.metric === "fileCount")
    ) {
      evidence.push({
        kind: "measurement",
        metric: record.metric,
        value: Number(record.value) || 0,
      });
    }
  }
  return evidence;
}

function coerceClassAnalyses(raw: unknown): ClassAnalysis[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
        : [];
    const checkedSubjects = list(record.checkedSubjects);
    const affectedSubjects = list(record.affectedSubjects);
    if (
      typeof record.subject !== "string" || record.subject.trim() === "" ||
      (record.scope !== "isolated" && record.scope !== "systemic") ||
      typeof record.rootCause !== "string" || record.rootCause.trim() === "" ||
      checkedSubjects.length === 0 ||
      affectedSubjects.some((subject) => !checkedSubjects.includes(subject)) ||
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

export interface CriticReply {
  /**
   * False when the reply contained no block matching the findings contract.
   * Callers must not treat that as "zero findings" — it means the critique
   * never arrived, which is the opposite of a clean review.
   */
  found: boolean;
  findings: Finding[];
  checkpointAssessments: CheckpointAssessment[];
  missingAssessments: string[];
  requirementsChangeRequested: boolean;
  requirementsChangeReason?: string;
  criteriaPatches: CriteriaPatch[];
  classAnalyses: ClassAnalysis[];
  missingClassAnalyses: string[];
  protocolFailure?: CriticProtocolFailure;
}

export interface CriteriaPatch {
  criterionId: string;
  kind: "clarification" | "substantive";
  intentPreserved: boolean;
  before: string;
  after: string;
  reason: string;
}

export interface CheckpointAssessment {
  workstreamId: string;
  status: "safe" | "unsafe";
  reason: string;
}

/** Parse a critic reply, discarding anything that does not fit the contract. */
export function parseCriticReply(
  output: string,
  expectedWorkstreamIds: readonly string[] = [],
): CriticReply {
  const extraction = extractJsonDetailed(output, (value) =>
    hasArrayKey(value, "findings"),
  );
  const parsed = extraction.value;
  if (typeof parsed !== "object" || parsed === null) {
    return {
      found: false,
      findings: [],
      checkpointAssessments: [],
      missingAssessments: [...expectedWorkstreamIds],
      requirementsChangeRequested: false,
      criteriaPatches: [],
      classAnalyses: [],
      missingClassAnalyses: [],
      ...(extraction.failure === undefined
        ? {}
        : { protocolFailure: extraction.failure }),
    };
  }
  const parsedRecord = parsed as Record<string, unknown>;
  const raw = parsedRecord.findings;
  if (!Array.isArray(raw)) {
    return {
      found: false,
      findings: [],
      checkpointAssessments: [],
      missingAssessments: [...expectedWorkstreamIds],
      requirementsChangeRequested: false,
      criteriaPatches: [],
      classAnalyses: [],
      missingClassAnalyses: [],
    };
  }
  const findings: Finding[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const severity = record.severity as Severity;
    const category = record.category as FindingCategory;
    if (!SEVERITIES.has(severity) || !CATEGORIES.has(category)) continue;
    if (typeof record.subject !== "string" || record.subject.trim() === "") {
      continue;
    }
    findings.push({
      severity,
      category,
      subject: record.subject.trim(),
      message:
        typeof record.message === "string" ? record.message : record.subject,
      evidence: coerceEvidence(record.evidence),
      ...(typeof record.workstreamId === "string"
        ? { workstreamId: record.workstreamId }
        : {}),
      ...(record.requiresReplan === true ? { requiresReplan: true } : {}),
    });
  }
  const assessmentById = new Map<string, CheckpointAssessment>();
  const classAnalyses = coerceClassAnalyses(parsedRecord.classAnalyses);
  const criteriaPatches = Array.isArray(parsedRecord.criteriaPatches)
    ? parsedRecord.criteriaPatches.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Record<string, unknown>;
        if (
          typeof record.criterionId !== "string" ||
          (record.kind !== "clarification" && record.kind !== "substantive") ||
          typeof record.intentPreserved !== "boolean" ||
          typeof record.before !== "string" ||
          typeof record.after !== "string" ||
          typeof record.reason !== "string"
        ) return [];
        return [{
          criterionId: record.criterionId,
          kind: record.kind as "clarification" | "substantive",
          intentPreserved: record.intentPreserved,
          before: record.before,
          after: record.after,
          reason: record.reason,
        }];
      })
    : [];
  if (Array.isArray(parsedRecord.checkpointAssessments)) {
    for (const item of parsedRecord.checkpointAssessments) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.workstreamId !== "string" ||
        (record.status !== "safe" && record.status !== "unsafe") ||
        typeof record.reason !== "string" ||
        record.reason.trim() === ""
      ) {
        continue;
      }
      assessmentById.set(record.workstreamId, {
        workstreamId: record.workstreamId,
        status: record.status,
        reason: record.reason.trim(),
      });
    }
  }
  return {
    found: true,
    findings,
    checkpointAssessments: [...assessmentById.values()],
    missingAssessments: expectedWorkstreamIds.filter(
      (id) => !assessmentById.has(id),
    ),
    requirementsChangeRequested:
      parsedRecord.requirementsChangeRequested === true,
    ...(typeof parsedRecord.requirementsChangeReason === "string" &&
    parsedRecord.requirementsChangeReason.trim() !== ""
      ? { requirementsChangeReason: parsedRecord.requirementsChangeReason.trim() }
      : {}),
    criteriaPatches,
    classAnalyses,
    missingClassAnalyses: findings
      .filter(haltsConvergence)
      .map(({ subject }) => subject)
      .filter((subject) => !classAnalyses.some((analysis) => analysis.subject === subject)),
  };
}

/** Findings only, for callers that treat an unparseable reply as empty. */
export function parseCriticFindings(output: string): Finding[] {
  return parseCriticReply(output).findings;
}

export interface WriterVerdict {
  applied: string[];
  rejected: Array<{ id: string; reason: string }>;
  resolutionProofs: Array<{
    id: string;
    changedPaths: string[];
    checkedSubjects: string[];
    completenessBasis: string;
  }>;
  /** False when the reply contained no block matching the verdict contract. */
  found: boolean;
}

export function parseWriterVerdict(output: string): WriterVerdict {
  const parsed = extractJson(
    output,
    (value) => hasArrayKey(value, "applied") || hasArrayKey(value, "rejected"),
  );
  const empty: WriterVerdict = { applied: [], rejected: [], resolutionProofs: [], found: false };
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;
  const applied = Array.isArray(record.applied)
    ? record.applied.filter((id): id is string => typeof id === "string")
    : [];
  const rejected = Array.isArray(record.rejected)
    ? record.rejected.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== "string") return [];
        return [
          {
            id: entry.id,
            reason:
              typeof entry.reason === "string" && entry.reason.trim() !== ""
                ? entry.reason
                : "no reason given",
          },
        ];
      })
    : [];
  const resolutionProofs = Array.isArray(record.resolutionProofs)
    ? record.resolutionProofs.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const proof = item as Record<string, unknown>;
        const changedPaths = Array.isArray(proof.changedPaths) ? proof.changedPaths.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
        const checkedSubjects = Array.isArray(proof.checkedSubjects) ? proof.checkedSubjects.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
        if (typeof proof.id !== "string" || changedPaths.length === 0 || checkedSubjects.length === 0 || typeof proof.completenessBasis !== "string" || proof.completenessBasis.trim() === "") return [];
        return [{ id: proof.id, changedPaths, checkedSubjects, completenessBasis: proof.completenessBasis.trim() }];
      })
    : [];
  return { applied, rejected, resolutionProofs, found: true };
}

interface Role {
  label: string;
  agent: AgentConfig;
}

/**
 * Roles alternate so neither model both writes and grades its own writing.
 * A critic that is also allowed to fix tends to stop finding — it converges
 * on its own taste rather than on quality — so the critic never edits, and
 * the two configured agents swap seats each round.
 */
function rolesForRound(
  round: number,
  primary: AgentConfig,
  secondary: AgentConfig,
): { critic: Role; writer: Role } {
  const swap = round % 2 === 0;
  return swap
    ? {
        critic: { label: describeAgent(primary), agent: primary },
        writer: { label: describeAgent(secondary), agent: secondary },
      }
    : {
        critic: { label: describeAgent(secondary), agent: secondary },
        writer: { label: describeAgent(primary), agent: primary },
      };
}

async function specPathsFor(
  root: string,
  programId: string,
): Promise<Array<{ id: string; taskFile: string }>> {
  try {
    const raw = JSON.parse(
      await readFile(
        join(root, "docs", "programs", `${programId}-manifest.json`),
        "utf8",
      ),
    ) as { workstreams?: Array<{ id: string; taskFile: string }> };
    return raw.workstreams ?? [];
  } catch {
    return [];
  }
}

export async function validateLoop(
  options: ValidateLoopOptions,
): Promise<ValidateLoopResult> {
  const root = resolve(options.cwd);
  const progress = (line: string): void => options.onProgress?.(line);
  const runAgent = options.agentRunner ?? defaultAgentRunner;

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return aborted(
      options.programId,
      error instanceof Error ? error.message : String(error),
    );
  }

  const strict = options.strict ?? config.validate.strict;
  const totalRounds = Math.min(
    options.rounds ?? config.validate.rounds,
    MAX_VALIDATE_ROUNDS,
  );

  // The spec loop runs `authorAgent`, not the build agent. Implementing a
  // workstream and judging a spec want different models, and the build agent
  // is often deliberately cheap.
  const author = resolveAuthorAgent(config);
  const secondary = resolveValidatorAgent(config);
  if (!author || !secondary) {
    return aborted(
      options.programId,
      !author
        ? "No `authorAgent` or `agent` configured in pipeline.config.json; the convergence loop needs two agents so critic and writer are never the same model."
        : "No `validatorAgent` configured in pipeline.config.json; the convergence loop needs two agents so critic and writer are never the same model.",
    );
  }
  const primary = author.agent;

  const agents: ResolvedAgents = {
    author: describeAgent(primary),
    validator: describeAgent(secondary),
    borrowedBuildAgent: author.borrowedBuildAgent,
  };
  // State the roles before spending anything, so an unintended model is
  // caught by reading the output rather than by reading the source.
  progress(
    `agents: author ${agents.author}, validator ${agents.validator}`,
  );
  if (author.borrowedBuildAgent) {
    progress(
      `WARNING: no authorAgent configured; borrowing the build agent (${agents.author}) to critique and rewrite specs. The build agent is often set to a cheaper model than the one that authored them — set authorAgent in pipeline.config.json.`,
    );
  }

  const workstreams = await specPathsFor(root, options.programId);
  const allSpecPaths = workstreams.map(({ taskFile }) => taskFile);

  const seen = new Map<string, IdentifiedFinding>();
  const unresolved = new Map<string, IdentifiedFinding>();
  const disagreements = new Map<string, Disagreement>();
  const rounds: RoundRecord[] = [];
  let changedWorkstreams: string[] = [];
  let outcome: LoopOutcome = "cap-reached";
  let reason: string | undefined;
  const replanFindings: IdentifiedFinding[] = [];
  let replanReport: string | undefined;
  const criticLogs: string[] = [];
  const stamp = (options.now?.() ?? new Date())
    .toISOString()
    .replace(/[:.]/gu, "-");
  const convergenceRunId = `${stamp}-${randomUUID().slice(0, 8)}`;
  const logDir = resolve(root, config.build.logDir);

  const preserveCriticResponse = async (
    round: number,
    attempt: number,
    output: string,
  ): Promise<string | undefined> => {
    const path = join(
      logDir,
      `${options.programId}-converge-${convergenceRunId}-round-${round}-critic-attempt-${attempt}.log`,
    );
    try {
      await mkdir(logDir, { recursive: true });
      await writeFile(path, output, { encoding: "utf8", flag: "wx" });
      criticLogs.push(path);
      return path;
    } catch (error) {
      progress(
        `WARNING: could not preserve critic response at ${path}: ${jsonError(error)}`,
      );
      return undefined;
    }
  };

  for (let round = 1; round <= totalRounds; round += 1) {
    // Rounds through `scopeDownAfterRound` always cover the whole program.
    // Scoping earlier would select workstreams via the declared dependency
    // graph, but an undeclared dependency is exactly the defect being hunted:
    // the workstream that silently consumes another's output is not in the
    // producer's neighbor set, so scoping would hide it.
    const mayScope =
      round > config.validate.scopeDownAfterRound &&
      changedWorkstreams.length > 0;
    const scopedIds = mayScope ? changedWorkstreams : [];
    const specPaths = mayScope
      ? workstreams
          .filter(({ id }) => scopedIds.includes(id))
          .map(({ taskFile }) => taskFile)
      : allSpecPaths;

    const sources = await loadBriefSources(
      root,
      options.programId,
      specPaths,
      {
        visionPath: config.visionPath,
        contextDocs: config.contextDocs,
      },
    );

    const { critic, writer } = rolesForRound(round, primary, secondary);
    const context: RoundContext = {
      round,
      totalRounds,
      scoped: mayScope,
      expectedWorkstreamIds: mayScope
        ? scopedIds
        : workstreams.map(({ id }) => id),
      openDisagreements: [...disagreements.values()].map(
        ({ finding, reason: declined }) => ({ finding, reason: declined }),
      ),
      alreadyRaised: [...seen.values()],
    };

    progress(
      `round ${round}/${totalRounds}: critic ${critic.label}${
        mayScope ? ` (scoped to ${scopedIds.join(", ")})` : ""
      }`,
    );

    let criticPrompt = composeCriticBrief(sources, context);
    let criticReply: CriticReply | undefined;
    let criticSummary: AgentSummary | undefined;
    let finalProtocolError = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const criticResult = await runAgent({
        command: critic.agent.command,
        args: critic.agent.args,
        prompt: criticPrompt,
        promptMode: critic.agent.promptMode,
        cwd: root,
      });
      const criticLog = await preserveCriticResponse(
        round,
        attempt,
        criticResult.output,
      );
      if (criticResult.exitCode !== 0) {
        return aborted(
          options.programId,
          `Critic agent (${critic.label})${attempt === 2 ? " correction retry" : ""} exited ${criticResult.exitCode}. Full response: ${criticLog ?? "could not be written"}. Output tail: ${tail(criticResult.output, 800)}`,
          { rounds, strict, findings: [...seen.values()], criticLogs },
        );
      }

      criticSummary = resolveSummary(criticResult.output);
      progress(
        `round ${round}: critic${attempt === 2 ? " correction" : ""} says: ${summaryLine(criticSummary)}`,
      );
      const parsedReply = parseCriticReply(
        criticResult.output,
        context.expectedWorkstreamIds,
      );
      finalProtocolError = !parsedReply.found
        ? `${parsedReply.protocolFailure?.kind ?? "contract-mismatch"}: ${parsedReply.protocolFailure?.message ?? "The required findings block could not be read."}`
        : parsedReply.missingAssessments.length > 0
          ? `missing-assessments: omitted checkpoint assessments for ${parsedReply.missingAssessments.join(", ")}`
          : parsedReply.missingClassAnalyses.length > 0
            ? `missing-class-analysis: omitted root-cause coverage for ${parsedReply.missingClassAnalyses.join(", ")}`
          : "";
      if (finalProtocolError === "") {
        criticReply = parsedReply;
        break;
      }
      if (attempt === 1) {
        progress(
          `round ${round}: critic protocol failure (${finalProtocolError}); retrying once to correct the response contract. Full response: ${criticLog ?? "could not be written"}`,
        );
        criticPrompt = composeCriticCorrectionBrief(
          criticResult.output,
          context.expectedWorkstreamIds,
          finalProtocolError,
        );
      }
    }

    if (!criticReply || !criticSummary) {
      return aborted(
        options.programId,
        `Critic agent (${critic.label}) response remained unreadable after one contract-correction retry (${finalProtocolError}). The gate failed closed. Full responses: ${criticLogs.slice(-2).join(", ") || "could not be written"}.`,
        { rounds, strict, findings: [...seen.values()], criticLogs },
      );
    }

    const substantiveCriteriaChange = criticReply.criteriaPatches.some(
      (patch) => patch.kind === "substantive" || !patch.intentPreserved,
    );
    if (
      criticReply.requirementsChangeRequested &&
      (substantiveCriteriaChange || criticReply.criteriaPatches.length === 0)
    ) {
      const requirementReason =
        criticReply.requirementsChangeReason ??
        "The critic requested a change to user requirements or success criteria.";
      progress(`round ${round}: requirements decision required; automatic replan stopped`);
      let humanReport: string | undefined;
      try {
        const written = await writeReplanReport(
          root,
          options.programId,
          config,
          {
            summary: "Convergence requires a human requirements decision.",
            replanFindings: [],
            relatedFindings: [...seen.values()],
            checkpointAssessments: criticReply.checkpointAssessments,
            criticSummary: requirementReason,
            criticLogs,
            classAnalyses: criticReply.classAnalyses,
            criteriaPatches: criticReply.criteriaPatches,
            outcome: "human-required",
            humanDecisionReason: requirementReason,
          },
          options.now,
        );
        humanReport = written.path;
      } catch (error) {
        progress(
          `WARNING: could not persist the human-decision handoff: ${jsonError(error)}`,
        );
      }
      return aborted(
        options.programId,
        [
          `Convergence requests a human requirements decision and will not automatically replan: ${requirementReason}`,
          ...(humanReport
            ? [
                `Decision report: ${humanReport}`,
                `Run /plan-program ${options.programId}; it will present these decisions and consume this report.`,
              ]
            : []),
        ].join("\n"),
        {
          rounds,
          strict,
          findings: [...seen.values()],
          criticLogs,
          ...(humanReport ? { replanReport: humanReport } : {}),
          requirementsChangeRequested: true,
        },
      );
    }

    if (criticReply.criteriaPatches.length > 0 && !substantiveCriteriaChange) {
      progress(
        `round ${round}: applying ${criticReply.criteriaPatches.length} intent-preserving criteria clarification(s) through the writer`,
      );
      criticReply.findings.push(
        ...criticReply.criteriaPatches.map((patch) => ({
          severity: "major" as const,
          category: "acceptance-criteria" as const,
          subject: patch.criterionId,
          message: `${patch.reason} Before: ${patch.before} After: ${patch.after}`,
          evidence: [
            {
              kind: "concern" as const,
              named: "intent-preserving acceptance-criteria clarification",
              detail: patch.criterionId,
            },
          ],
        })),
      );
    }

    const unsafeCheckpointFindings: Finding[] =
      criticReply.checkpointAssessments
        .filter(({ status }) => status === "unsafe")
        .map(({ workstreamId, reason: assessmentReason }) => ({
          severity: "blocker",
          category: "scope-structure",
          subject: `${workstreamId} checkpoint safety`,
          message: assessmentReason,
          evidence: [
            {
              kind: "concern",
              named: "workstream is not an independently green checkpoint",
              detail: assessmentReason,
            },
          ],
          workstreamId,
          requiresReplan: true,
        }));
    const raised = applySeverityPolicy([
      ...criticReply.findings,
      ...unsafeCheckpointFindings,
    ]).map(identify);

    const replan = raised.filter((finding) => finding.requiresReplan === true);
    const fresh = raised.filter(
      (finding) => !seen.has(finding.id) && haltsConvergence(finding),
    );
    for (const finding of raised) {
      if (!seen.has(finding.id)) seen.set(finding.id, finding);
      if (haltsConvergence(finding)) unresolved.set(finding.id, finding);
    }

    const raisedIds = new Set(raised.map(({ id }) => id));
    for (const id of disagreements.keys()) {
      if (!raisedIds.has(id)) {
        unresolved.delete(id);
      }
    }

    // A finding the writer declined and the critic then re-raised is a real
    // disagreement between two models. Record it for a human rather than
    // letting the loop settle it by whoever happens to edit last.
    for (const finding of raised) {
      const open = disagreements.get(finding.id);
      if (open && !open.rounds.includes(round)) open.rounds.push(round);
    }

    if (replan.length > 0) {
      replanFindings.push(...replan);
      rounds.push({
        round,
        critic: critic.label,
        scoped: mayScope,
        ...(mayScope ? { scopedTo: scopedIds } : {}),
        raised: raised.length,
        fresh: fresh.length,
        applied: 0,
        rejected: 0,
        criticSummary: criticSummary.text,
      });
      outcome = "requires-replan";
      reason = `${replan.length} finding(s) cannot be fixed by editing specs; the program needs replanning.`;
      try {
        const written = await writeReplanReport(
          root,
          options.programId,
          config,
          {
            summary: reason,
            replanFindings: replan,
            relatedFindings: raised,
            checkpointAssessments: criticReply.checkpointAssessments,
            criticSummary: criticSummary.text,
            criticLogs,
            classAnalyses: criticReply.classAnalyses,
            criteriaPatches: criticReply.criteriaPatches,
          },
          options.now,
        );
        replanReport = written.path;
        progress(`replan report: ${written.path}`);
      } catch (error) {
        progress(
          `WARNING: could not write the replan report: ${jsonError(error)}`,
        );
      }
      progress(`round ${round}: ${reason}`);
      break;
    }

    if (fresh.length === 0) {
      rounds.push({
        round,
        critic: critic.label,
        scoped: mayScope,
        ...(mayScope ? { scopedTo: scopedIds } : {}),
        raised: raised.length,
        fresh: 0,
        applied: 0,
        rejected: 0,
        criticSummary: criticSummary.text,
      });
      const stillRaised = raised.filter(haltsConvergence);
      if (stillRaised.length > 0) {
        outcome = "cap-reached";
        reason = `Round ${round} re-raised ${stillRaised.length} unresolved blocker/major finding(s); unchanged findings cannot be treated as convergence.`;
        progress(`round ${round}: unresolved findings remain`);
      } else {
        outcome = "converged";
        reason = `Round ${round} produced no unresolved blocker or major findings.`;
        progress(`round ${round}: converged`);
      }
      break;
    }

    progress(
      `round ${round}: ${fresh.length} new blocker/major finding(s); writer ${writer.label}`,
    );

    const writerResult = await runAgent({
      command: writer.agent.command,
      args: writer.agent.args,
      prompt: composeWriterBrief(sources, fresh, context, criticReply.classAnalyses),
      promptMode: writer.agent.promptMode,
      cwd: root,
    });
    if (writerResult.exitCode !== 0) {
      return aborted(
        options.programId,
        `Writer agent (${writer.label}) exited ${writerResult.exitCode}: ${tail(writerResult.output, 800)}`,
        { rounds, strict, findings: [...seen.values()], criticLogs },
      );
    }

    const writerSummary = resolveSummary(writerResult.output);
    progress(`round ${round}: writer says: ${summaryLine(writerSummary)}`);

    const verdict = parseWriterVerdict(writerResult.output);
    // Same reasoning as the critic: an unreadable verdict is not "applied
    // nothing, declined nothing". The writer may well have edited the specs,
    // so continuing would leave the loop's record of what happened wrong.
    if (!verdict.found) {
      return aborted(
        options.programId,
        `Writer agent (${writer.label}) returned no verdict block matching the contract, so which findings it applied or declined could not be read. Inspect the working tree before re-running — the specs may already have been edited. Output tail: ${tail(writerResult.output, 800)}`,
        { rounds, strict, findings: [...seen.values()], criticLogs },
      );
    }
    const provedIds = new Set(verdict.resolutionProofs.map(({ id }) => id));
    const unproved = verdict.applied.filter((id) => !provedIds.has(id));
    if (unproved.length > 0) {
      return aborted(
        options.programId,
        `Writer agent (${writer.label}) marked findings applied without class-wide resolution proof: ${unproved.join(", ")}.`,
        { rounds, strict, findings: [...seen.values()], criticLogs },
      );
    }
    for (const { id, reason: declined } of verdict.rejected) {
      const finding = seen.get(id);
      if (!finding) continue;
      const existing = disagreements.get(id);
      if (existing) existing.rounds.push(round);
      else disagreements.set(id, { finding, reason: declined, rounds: [round] });
    }
    // Applied findings are resolved; a later round re-raising one turns it
    // back into an open item through the normal `fresh` path.
    for (const id of verdict.applied) {
      disagreements.delete(id);
      unresolved.delete(id);
    }

    changedWorkstreams = [
      ...new Set(
        fresh
          .filter(({ id }) => verdict.applied.includes(id))
          .flatMap((finding) =>
            finding.workstreamId ? [finding.workstreamId] : [],
          ),
      ),
    ];

    rounds.push({
      round,
      critic: critic.label,
      writer: writer.label,
      scoped: mayScope,
      ...(mayScope ? { scopedTo: scopedIds } : {}),
      raised: raised.length,
      fresh: fresh.length,
      applied: verdict.applied.length,
      rejected: verdict.rejected.length,
      criticSummary: criticSummary.text,
      writerSummary: writerSummary.text,
    });
  }

  if (outcome === "cap-reached") {
    reason ??= `Round cap (${totalRounds}) reached before a clean critic round confirmed the fixes.`;
  }

  // Mechanical validation and semantic convergence are both gates. A round
  // cap is not success: fixes made by the last writer have not received a
  // clean independent review, and an unchanged blocker/major is unresolved,
  // not evidence that the loop converged.
  const mechanical = await validateWorkstreams(root, options.programId, strict);
  const modelFindings = [...seen.values()];
  const combined = dedupe([
    ...mechanical.findings.map(identify),
    ...modelFindings,
  ]);
  const riskWaived =
    options.allowSemanticRisks === true &&
    outcome === "cap-reached" &&
    replanFindings.length === 0 &&
    ![...unresolved.values()].some(({ severity }) => severity === "blocker");
  if (riskWaived) {
    progress(
      `convergence: accepting ${unresolved.size} unresolved semantic finding(s) as an explicit risk waiver`,
    );
  }
  const gateFailed =
    mechanical.result === "FAILED" ||
    (outcome !== "converged" && !riskWaived) ||
    (unresolved.size > 0 && !riskWaived);

  let convergenceReceipt: string | undefined;
  if (!gateFailed) {
    try {
      const receipt = await writeConvergenceReceipt(
        root,
        options.programId,
        config,
        options.now,
        riskWaived ? [...unresolved.keys()] : [],
      );
      convergenceReceipt = receipt.inputHash;
      await clearReplanReport(root, options.programId);
      progress(`convergence receipt: ${receipt.inputHash.slice(0, 12)}`);
    } catch (error) {
      return aborted(
        options.programId,
        `Convergence passed but its receipt could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { rounds, strict, findings: combined, criticLogs },
      );
    }
  }

  return {
    programId: options.programId,
    outcome,
    result: gateFailed ? "FAILED" : "PASSED",
    ...(reason === undefined ? {} : { reason }),
    agents,
    strict,
    rounds,
    findings: sortBySeverity(combined) as IdentifiedFinding[],
    openDisagreements: [...disagreements.values()],
    replanFindings,
    ...(convergenceReceipt === undefined ? {} : { convergenceReceipt }),
    criticLogs,
    ...(replanReport === undefined ? {} : { replanReport }),
  };
}

function dedupe(findings: IdentifiedFinding[]): IdentifiedFinding[] {
  const byId = new Map<string, IdentifiedFinding>();
  for (const finding of findings) {
    if (!byId.has(finding.id)) byId.set(finding.id, finding);
  }
  return [...byId.values()];
}

function aborted(
  programId: string,
  reason: string,
  partial?: {
    rounds: RoundRecord[];
    strict: boolean;
    findings: IdentifiedFinding[];
    criticLogs?: string[];
    replanReport?: string;
    requirementsChangeRequested?: boolean;
  },
): ValidateLoopResult {
  return {
    programId,
    outcome: "aborted",
    result: "FAILED",
    reason,
    strict: partial?.strict ?? false,
    rounds: partial?.rounds ?? [],
    findings: partial?.findings ?? [],
    openDisagreements: [],
    replanFindings: [],
    criticLogs: partial?.criticLogs ?? [],
    ...(partial?.replanReport === undefined
      ? {}
      : { replanReport: partial.replanReport }),
    ...(partial?.requirementsChangeRequested === undefined
      ? {}
      : { requirementsChangeRequested: partial.requirementsChangeRequested }),
  };
}

export { fingerprint };
