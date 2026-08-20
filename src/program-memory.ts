import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IdentifiedFinding, Severity } from "./findings.js";

/**
 * Program memory: the durable record of what the pipeline concluded and why.
 *
 * Two layers with opposite growth behavior:
 *
 * - The **journal** (`docs/programs/{id}-memory.jsonl`) is append-only and is
 *   never placed in a prompt. It is the source of truth; every read reduces
 *   it from scratch, so a corrupted or hand-edited view file costs nothing.
 * - The **view** (`docs/programs/{id}-memory.json`) is the derived current
 *   state — one entry per finding fingerprint regardless of how many runs
 *   re-raised it. It exists for humans and for agents that pull context on
 *   demand; the runner itself always reduces the journal.
 *
 * Both live under `docs/programs/` and are committed, deliberately: memory
 * that dies with a machine or a gitignored directory is what made every run
 * start blind. Only the runner writes here — agents receive projections in
 * their briefs and read the view file, exactly the separation the runner
 * already applies to commits and summaries.
 *
 * Model output recorded here is **context, never precedent**: a writer's
 * decline is a position the next critic must engage, not a settlement.
 * Only human decisions carry authority, and even those are revocable.
 */

export const MEMORY_SCHEMA_VERSION = 1;

export type FindingStatus =
  | "open"
  | "fix-applied"
  | "declined"
  | "resolved"
  | "waived"
  | "superseded";

export interface HumanDecision {
  decision: "waived" | "upheld";
  rationale: string;
  at: string;
}

/** One entry in a finding's raise/decline conversation, oldest first. */
export interface Exchange {
  runId: string;
  round?: number;
  action:
    | "raised"
    | "applied"
    | "declined"
    | "decline-accepted"
    | "downgraded"
    | "waived"
    | "human-decision";
  severity?: Severity;
  rationale?: string;
  at: string;
}

const MAX_EXCHANGES = 12;

export interface FindingMemory {
  /** The latest version raised — re-raises update it, unlike the loop's first-wins ledger. */
  finding: IdentifiedFinding;
  status: FindingStatus;
  firstRaised: { runId: string; round?: number; at: string };
  exchanges: Exchange[];
  raiseCount: number;
  declineCount: number;
  lastDeclineReason?: string;
  humanDecision?: HumanDecision;
}

export interface RunSummary {
  runId: string;
  stage: string;
  startedAt: string;
  outcome?: string;
  result?: string;
  reason?: string;
}

export interface CheckpointMemory {
  status: "safe" | "unsafe";
  reason: string;
  runId: string;
  at: string;
}

/** One attempt at a unit of work — `build:WS-03`, `replan`, `author:WS-07`. */
export interface AttemptRecord {
  runId: string;
  attempt: number;
  outcome: "failed" | "succeeded";
  reason?: string;
  /** Bounded output excerpt — the evidence that mattered, never a log path. */
  excerpt?: string;
  failedCommand?: string;
  at: string;
}

/** A stage-level structural diagnosis (cycle, unmet requirement, oversize). */
export interface DiagnosisRecord {
  stage: string;
  outcome: string;
  reason: string;
  detail?: string;
  runId: string;
  at: string;
}

const MAX_ATTEMPTS_PER_UNIT = 8;
const MAX_DIAGNOSES = 20;

export interface ProgramMemoryView {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  programId: string;
  updatedAt: string;
  runs: RunSummary[];
  findings: Record<string, FindingMemory>;
  checkpoints: Record<string, CheckpointMemory>;
  attempts: Record<string, AttemptRecord[]>;
  diagnoses: DiagnosisRecord[];
}

interface EventBase {
  at: string;
  runId: string;
}

export type MemoryEvent =
  | (EventBase & { kind: "run-started"; stage: string })
  | (EventBase & {
      kind: "finding-raised";
      round?: number;
      finding: IdentifiedFinding;
    })
  | (EventBase & { kind: "finding-applied"; round?: number; id: string })
  | (EventBase & {
      kind: "finding-declined";
      round?: number;
      id: string;
      reason: string;
    })
  | (EventBase & { kind: "decline-accepted"; round?: number; id: string })
  | (EventBase & {
      kind: "severity-downgraded";
      id: string;
      from: Severity;
      reason: string;
    })
  | (EventBase & {
      kind: "checkpoint-assessed";
      workstreamId: string;
      status: "safe" | "unsafe";
      reason: string;
    })
  | (EventBase & {
      kind: "round-completed";
      round: number;
      critic: string;
      writer?: string;
      raised: number;
      fresh: number;
      applied: number;
      rejected: number;
      criticSummary?: string;
      writerSummary?: string;
    })
  | (EventBase & {
      kind: "loop-finished";
      stage: string;
      outcome: string;
      result: string;
      reason?: string;
      waivedFindings?: string[];
    })
  | (EventBase & {
      kind: "human-decision";
      id: string;
      decision: "waived" | "upheld";
      rationale: string;
    })
  | (EventBase & {
      kind: "attempt-recorded";
      unit: string;
      attempt: number;
      outcome: "failed" | "succeeded";
      reason?: string;
      excerpt?: string;
      failedCommand?: string;
    })
  | (EventBase & {
      kind: "stage-diagnosis";
      stage: string;
      outcome: string;
      reason: string;
      detail?: string;
    });

type DistributeInput<T> = T extends unknown ? Omit<T, "at" | "runId"> : never;
/** A memory event minus the envelope the recorder stamps on every entry. */
export type MemoryEventInput = DistributeInput<MemoryEvent>;

export function memoryJournalPath(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-memory.jsonl`);
}

export function memoryViewPath(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-memory.json`);
}

function emptyView(programId: string): ProgramMemoryView {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    programId,
    updatedAt: "",
    runs: [],
    findings: {},
    checkpoints: {},
    attempts: {},
    diagnoses: [],
  };
}

function pushExchange(entry: FindingMemory, exchange: Exchange): void {
  entry.exchanges.push(exchange);
  if (entry.exchanges.length > MAX_EXCHANGES) {
    entry.exchanges.splice(0, entry.exchanges.length - MAX_EXCHANGES);
  }
}

/**
 * Fold the journal into the current state. Deliberately dumb: status
 * transitions only, no gate semantics — the loop decides what passes, memory
 * records what the loop decided.
 */
export function reduceMemoryEvents(
  programId: string,
  events: readonly MemoryEvent[],
): ProgramMemoryView {
  const view = emptyView(programId);
  const runsById = new Map<string, RunSummary>();
  for (const event of events) {
    view.updatedAt = event.at;
    if (event.kind === "run-started") {
      if (!runsById.has(event.runId)) {
        const run: RunSummary = {
          runId: event.runId,
          stage: event.stage,
          startedAt: event.at,
        };
        runsById.set(event.runId, run);
        view.runs.push(run);
      }
      continue;
    }
    if (event.kind === "loop-finished") {
      let run = runsById.get(event.runId);
      if (!run) {
        run = { runId: event.runId, stage: event.stage, startedAt: event.at };
        runsById.set(event.runId, run);
        view.runs.push(run);
      }
      run.outcome = event.outcome;
      run.result = event.result;
      if (event.reason !== undefined) run.reason = event.reason;
      const waived = new Set(event.waivedFindings ?? []);
      for (const [id, entry] of Object.entries(view.findings)) {
        if (waived.has(id)) {
          entry.status = "waived";
          pushExchange(entry, {
            runId: event.runId,
            action: "waived",
            at: event.at,
          });
        } else if (
          event.outcome === "converged" &&
          (entry.status === "open" || entry.status === "fix-applied")
        ) {
          // A clean confirming round covered the whole program; anything the
          // critic no longer raises is resolved, not merely quiet.
          entry.status = "resolved";
        }
      }
      continue;
    }
    if (event.kind === "checkpoint-assessed") {
      view.checkpoints[event.workstreamId] = {
        status: event.status,
        reason: event.reason,
        runId: event.runId,
        at: event.at,
      };
      continue;
    }
    if (event.kind === "round-completed") continue;
    if (event.kind === "attempt-recorded") {
      const records = (view.attempts[event.unit] ??= []);
      records.push({
        runId: event.runId,
        attempt: event.attempt,
        outcome: event.outcome,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.excerpt === undefined ? {} : { excerpt: event.excerpt }),
        ...(event.failedCommand === undefined
          ? {}
          : { failedCommand: event.failedCommand }),
        at: event.at,
      });
      if (records.length > MAX_ATTEMPTS_PER_UNIT) {
        records.splice(0, records.length - MAX_ATTEMPTS_PER_UNIT);
      }
      continue;
    }
    if (event.kind === "stage-diagnosis") {
      view.diagnoses.push({
        stage: event.stage,
        outcome: event.outcome,
        reason: event.reason,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        runId: event.runId,
        at: event.at,
      });
      if (view.diagnoses.length > MAX_DIAGNOSES) {
        view.diagnoses.splice(0, view.diagnoses.length - MAX_DIAGNOSES);
      }
      continue;
    }
    if (event.kind === "finding-raised") {
      const existing = view.findings[event.finding.id];
      if (existing) {
        // Latest version wins: a re-raise with sharper evidence or a new
        // severity replaces the stale original instead of being discarded.
        existing.finding = event.finding;
        existing.status = "open";
        existing.raiseCount += 1;
        pushExchange(existing, {
          runId: event.runId,
          ...(event.round === undefined ? {} : { round: event.round }),
          action: "raised",
          severity: event.finding.severity,
          ...(event.finding.message === ""
            ? {}
            : { rationale: event.finding.message }),
          at: event.at,
        });
      } else {
        const entry: FindingMemory = {
          finding: event.finding,
          status: "open",
          firstRaised: {
            runId: event.runId,
            ...(event.round === undefined ? {} : { round: event.round }),
            at: event.at,
          },
          exchanges: [],
          raiseCount: 1,
          declineCount: 0,
        };
        pushExchange(entry, {
          runId: event.runId,
          ...(event.round === undefined ? {} : { round: event.round }),
          action: "raised",
          severity: event.finding.severity,
          ...(event.finding.message === ""
            ? {}
            : { rationale: event.finding.message }),
          at: event.at,
        });
        view.findings[event.finding.id] = entry;
      }
      continue;
    }
    const entry = view.findings[event.id];
    if (!entry) continue;
    switch (event.kind) {
      case "finding-applied":
        entry.status = "fix-applied";
        pushExchange(entry, {
          runId: event.runId,
          ...(event.round === undefined ? {} : { round: event.round }),
          action: "applied",
          at: event.at,
        });
        break;
      case "finding-declined":
        entry.status = "declined";
        entry.declineCount += 1;
        entry.lastDeclineReason = event.reason;
        pushExchange(entry, {
          runId: event.runId,
          ...(event.round === undefined ? {} : { round: event.round }),
          action: "declined",
          rationale: event.reason,
          at: event.at,
        });
        break;
      case "decline-accepted":
        entry.status = "resolved";
        pushExchange(entry, {
          runId: event.runId,
          ...(event.round === undefined ? {} : { round: event.round }),
          action: "decline-accepted",
          at: event.at,
        });
        break;
      case "severity-downgraded":
        pushExchange(entry, {
          runId: event.runId,
          action: "downgraded",
          severity: event.from,
          rationale: event.reason,
          at: event.at,
        });
        break;
      case "human-decision":
        entry.humanDecision = {
          decision: event.decision,
          rationale: event.rationale,
          at: event.at,
        };
        entry.status = event.decision === "waived" ? "waived" : "open";
        pushExchange(entry, {
          runId: event.runId,
          action: "human-decision",
          rationale: `${event.decision}: ${event.rationale}`,
          at: event.at,
        });
        break;
    }
  }
  return view;
}

/** Parse the journal, skipping malformed lines rather than failing the read. */
export async function readMemoryJournal(
  root: string,
  programId: string,
): Promise<MemoryEvent[]> {
  let raw: string;
  try {
    raw = await readFile(memoryJournalPath(root, programId), "utf8");
  } catch {
    return [];
  }
  const events: MemoryEvent[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as MemoryEvent;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.kind === "string" &&
        typeof parsed.at === "string" &&
        typeof parsed.runId === "string"
      ) {
        events.push(parsed);
      }
    } catch {
      // A damaged line loses one event, never the ledger.
    }
  }
  return events;
}

/** The current state, reduced from the journal (the view file is never trusted). */
export async function readProgramMemory(
  root: string,
  programId: string,
): Promise<ProgramMemoryView> {
  return reduceMemoryEvents(programId, await readMemoryJournal(root, programId));
}

/**
 * Append events to the journal and refresh the derived view. The view write
 * is best-effort — the journal is the record; the view can always be rebuilt.
 */
export async function appendMemoryEvents(
  root: string,
  programId: string,
  events: readonly MemoryEvent[],
): Promise<ProgramMemoryView> {
  if (events.length === 0) return readProgramMemory(root, programId);
  const journal = memoryJournalPath(root, programId);
  await mkdir(join(resolve(root), "docs", "programs"), { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  await appendFile(journal, lines, "utf8");
  const view = await readProgramMemory(root, programId);
  await writeFile(
    memoryViewPath(root, programId),
    `${JSON.stringify(view, null, 2)}\n`,
    "utf8",
  );
  return view;
}

/**
 * The brief projection: findings from prior runs a critic must know about.
 * Constraints are pushed, evidence is pulled — this carries the conclusion
 * and rationale of each unsettled or human-decided finding, and the brief
 * points at the view file for everything else.
 */
export interface PriorRunFinding {
  finding: IdentifiedFinding;
  status: FindingStatus;
  raiseCount: number;
  declineCount: number;
  lastDeclineReason?: string;
  humanDecision?: HumanDecision;
}

export function priorRunFindings(
  view: ProgramMemoryView,
  options: { excludeRunId?: string } = {},
): PriorRunFinding[] {
  const entries: PriorRunFinding[] = [];
  for (const entry of Object.values(view.findings)) {
    if (entry.status === "resolved" || entry.status === "superseded") continue;
    if (
      options.excludeRunId !== undefined &&
      entry.firstRaised.runId === options.excludeRunId &&
      entry.exchanges.every(({ runId }) => runId === options.excludeRunId)
    ) {
      continue;
    }
    entries.push({
      finding: entry.finding,
      status: entry.status,
      raiseCount: entry.raiseCount,
      declineCount: entry.declineCount,
      ...(entry.lastDeclineReason === undefined
        ? {}
        : { lastDeclineReason: entry.lastDeclineReason }),
      ...(entry.humanDecision === undefined
        ? {}
        : { humanDecision: entry.humanDecision }),
    });
  }
  return entries;
}

/** The unit's most recent attempt, when that attempt failed — the state a
 * resumed run must not rediscover from scratch. */
export function lastFailedAttempt(
  view: ProgramMemoryView,
  unit: string,
): AttemptRecord | undefined {
  const last = view.attempts[unit]?.at(-1);
  return last?.outcome === "failed" ? last : undefined;
}

export function countByStatus(
  view: ProgramMemoryView,
): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = {
    open: 0,
    "fix-applied": 0,
    declined: 0,
    resolved: 0,
    waived: 0,
    superseded: 0,
  };
  for (const entry of Object.values(view.findings)) counts[entry.status] += 1;
  return counts;
}
