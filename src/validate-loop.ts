import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveAgent,
  resolveValidatorAgent,
  tail,
  type AgentRunner,
} from "./agent-runner.js";
import {
  FINDING_CATEGORIES,
  fingerprint,
  haltsConvergence,
  identify,
  sortBySeverity,
  type Evidence,
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
import { validateWorkstreams } from "./validate.js";
import {
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
}

export interface ValidateLoopResult {
  programId: string;
  outcome: LoopOutcome;
  /** The gate verdict, decided independently of why the loop stopped. */
  result: "PASSED" | "FAILED";
  reason?: string;
  strict: boolean;
  rounds: RoundRecord[];
  findings: IdentifiedFinding[];
  openDisagreements: Disagreement[];
  replanFindings: IdentifiedFinding[];
}

export interface ValidateLoopOptions {
  cwd: string;
  programId: string;
  rounds?: number;
  strict?: boolean;
  agentRunner?: AgentRunner;
  onProgress?: (line: string) => void;
}

/**
 * Model replies wrap JSON in prose and fences. Take the last fenced json
 * block, else the last balanced brace span.
 */
export function extractJson(output: string): unknown {
  const fences = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gu)];
  for (const match of fences.reverse()) {
    try {
      return JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(output.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
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

/** Parse a critic reply, discarding anything that does not fit the contract. */
export function parseCriticFindings(output: string): Finding[] {
  const parsed = extractJson(output);
  if (typeof parsed !== "object" || parsed === null) return [];
  const raw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
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
  return findings;
}

export interface WriterVerdict {
  applied: string[];
  rejected: Array<{ id: string; reason: string }>;
}

export function parseWriterVerdict(output: string): WriterVerdict {
  const parsed = extractJson(output);
  const empty: WriterVerdict = { applied: [], rejected: [] };
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
  return { applied, rejected };
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

  const primary = resolveAgent(config);
  const secondary = resolveValidatorAgent(config);
  if (!primary || !secondary) {
    return aborted(
      options.programId,
      !primary
        ? "No `agent` configured in pipeline.config.json; the convergence loop needs two agents so critic and writer are never the same model."
        : "No `validatorAgent` configured in pipeline.config.json; the convergence loop needs two agents so critic and writer are never the same model.",
    );
  }

  const workstreams = await specPathsFor(root, options.programId);
  const allSpecPaths = workstreams.map(({ taskFile }) => taskFile);

  const seen = new Map<string, IdentifiedFinding>();
  const disagreements = new Map<string, Disagreement>();
  const rounds: RoundRecord[] = [];
  let changedWorkstreams: string[] = [];
  let outcome: LoopOutcome = "cap-reached";
  let reason: string | undefined;
  const replanFindings: IdentifiedFinding[] = [];

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

    const criticResult = await runAgent({
      command: critic.agent.command,
      args: critic.agent.args,
      prompt: composeCriticBrief(sources, context),
      promptMode: critic.agent.promptMode,
      cwd: root,
    });
    if (criticResult.exitCode !== 0) {
      return aborted(
        options.programId,
        `Critic agent (${critic.label}) exited ${criticResult.exitCode}: ${tail(criticResult.output, 800)}`,
        { rounds, strict, findings: [...seen.values()] },
      );
    }

    const raised = applySeverityPolicy(
      parseCriticFindings(criticResult.output),
    ).map(identify);

    const replan = raised.filter((finding) => finding.requiresReplan === true);
    const fresh = raised.filter(
      (finding) => !seen.has(finding.id) && haltsConvergence(finding),
    );
    for (const finding of raised) {
      if (!seen.has(finding.id)) seen.set(finding.id, finding);
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
      });
      outcome = "requires-replan";
      reason = `${replan.length} finding(s) cannot be fixed by editing specs; the program needs replanning.`;
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
      });
      outcome = "converged";
      reason = `Round ${round} produced no new blocker or major findings.`;
      progress(`round ${round}: converged`);
      break;
    }

    progress(
      `round ${round}: ${fresh.length} new blocker/major finding(s); writer ${writer.label}`,
    );

    const writerResult = await runAgent({
      command: writer.agent.command,
      args: writer.agent.args,
      prompt: composeWriterBrief(sources, fresh, context),
      promptMode: writer.agent.promptMode,
      cwd: root,
    });
    if (writerResult.exitCode !== 0) {
      return aborted(
        options.programId,
        `Writer agent (${writer.label}) exited ${writerResult.exitCode}: ${tail(writerResult.output, 800)}`,
        { rounds, strict, findings: [...seen.values()] },
      );
    }

    const verdict = parseWriterVerdict(writerResult.output);
    for (const { id, reason: declined } of verdict.rejected) {
      const finding = seen.get(id);
      if (!finding) continue;
      const existing = disagreements.get(id);
      if (existing) existing.rounds.push(round);
      else disagreements.set(id, { finding, reason: declined, rounds: [round] });
    }
    // Applied findings are resolved; a later round re-raising one turns it
    // back into an open item through the normal `fresh` path.
    for (const id of verdict.applied) disagreements.delete(id);

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
    });
  }

  if (outcome === "cap-reached") {
    reason = `Round cap (${totalRounds}) reached with findings still open.`;
  }

  // The gate is decided by the deterministic validator over the final tree,
  // not by the loop's stopping condition — a loop that converged still fails
  // if a blocker survived it, and a loop that hit its cap still passes if
  // everything left open is advisory.
  const mechanical = await validateWorkstreams(root, options.programId, strict);
  const modelFindings = [...seen.values()];
  const combined = dedupe([
    ...mechanical.findings.map(identify),
    ...modelFindings,
  ]);
  const gateFailed =
    mechanical.result === "FAILED" || outcome === "requires-replan";

  return {
    programId: options.programId,
    outcome,
    result: gateFailed ? "FAILED" : "PASSED",
    ...(reason === undefined ? {} : { reason }),
    strict,
    rounds,
    findings: sortBySeverity(combined) as IdentifiedFinding[],
    openDisagreements: [...disagreements.values()],
    replanFindings,
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
  };
}

export { fingerprint };
