import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identify, type Finding } from "../src/findings.js";
import {
  appendMemoryEvents,
  countByStatus,
  memoryJournalPath,
  memoryViewPath,
  priorRunFindings,
  readProgramMemory,
  reduceMemoryEvents,
  type MemoryEvent,
} from "../src/program-memory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "program-pipeline-memory-"));
  temporaryRoots.push(dir);
  return dir;
}

function finding(overrides: Partial<Finding> = {}): ReturnType<typeof identify> {
  return identify({
    severity: "blocker",
    category: "coverage",
    subject: "SC-02",
    message: "No workstream covers SC-02.",
    evidence: [{ kind: "concern", named: "uncovered criterion" }],
    ...overrides,
  });
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

describe("reduceMemoryEvents", () => {
  it("tracks the raise → decline → re-raise → apply → converged lifecycle", () => {
    const f = finding();
    const events: MemoryEvent[] = [
      { kind: "run-started", stage: "converge", runId: "run-1", at: at(0) },
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(1) },
      {
        kind: "finding-declined",
        round: 1,
        id: f.id,
        reason: "out of scope",
        runId: "run-1",
        at: at(2),
      },
    ];
    let view = reduceMemoryEvents("alpha", events);
    expect(view.findings[f.id]?.status).toBe("declined");
    expect(view.findings[f.id]?.lastDeclineReason).toBe("out of scope");
    expect(view.findings[f.id]?.declineCount).toBe(1);

    // Re-raised in a later run with sharper wording: latest version wins.
    const sharper = finding({ message: "SC-02 has no owner in any scope block." });
    events.push(
      { kind: "run-started", stage: "converge", runId: "run-2", at: at(3) },
      {
        kind: "finding-raised",
        round: 1,
        finding: sharper,
        runId: "run-2",
        at: at(4),
      },
      { kind: "finding-applied", round: 1, id: f.id, runId: "run-2", at: at(5) },
      {
        kind: "loop-finished",
        stage: "converge",
        outcome: "converged",
        result: "PASSED",
        runId: "run-2",
        at: at(6),
      },
    );
    view = reduceMemoryEvents("alpha", events);
    const entry = view.findings[f.id];
    expect(entry?.finding.message).toBe("SC-02 has no owner in any scope block.");
    expect(entry?.raiseCount).toBe(2);
    expect(entry?.status).toBe("resolved");
    expect(view.runs).toHaveLength(2);
    expect(view.runs[1]?.outcome).toBe("converged");
  });

  it("resolves a declined finding when the critic accepts the decline", () => {
    const f = finding();
    const view = reduceMemoryEvents("alpha", [
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(0) },
      {
        kind: "finding-declined",
        round: 1,
        id: f.id,
        reason: "not a defect",
        runId: "run-1",
        at: at(1),
      },
      { kind: "decline-accepted", round: 1, id: f.id, runId: "run-2", at: at(2) },
    ]);
    expect(view.findings[f.id]?.status).toBe("resolved");
  });

  it("marks waived findings from a risk-waived loop finish", () => {
    const f = finding({ severity: "major" });
    const view = reduceMemoryEvents("alpha", [
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(0) },
      {
        kind: "loop-finished",
        stage: "converge",
        outcome: "cap-reached",
        result: "PASSED",
        waivedFindings: [f.id],
        runId: "run-1",
        at: at(1),
      },
    ]);
    expect(view.findings[f.id]?.status).toBe("waived");
    expect(countByStatus(view).waived).toBe(1);
  });

  it("records human decisions as authoritative but revocable state", () => {
    const f = finding();
    const view = reduceMemoryEvents("alpha", [
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(0) },
      {
        kind: "human-decision",
        id: f.id,
        decision: "waived",
        rationale: "accepted risk for this release",
        runId: "run-2",
        at: at(1),
      },
    ]);
    const entry = view.findings[f.id];
    expect(entry?.status).toBe("waived");
    expect(entry?.humanDecision?.decision).toBe("waived");
    expect(entry?.humanDecision?.rationale).toBe(
      "accepted risk for this release",
    );
  });
});

describe("priorRunFindings", () => {
  it("projects unsettled findings and omits resolved ones", () => {
    const declined = finding();
    const resolved = finding({ subject: "SC-03" });
    const view = reduceMemoryEvents("alpha", [
      {
        kind: "finding-raised",
        round: 1,
        finding: declined,
        runId: "run-1",
        at: at(0),
      },
      {
        kind: "finding-declined",
        round: 1,
        id: declined.id,
        reason: "intended behavior",
        runId: "run-1",
        at: at(1),
      },
      {
        kind: "finding-raised",
        round: 1,
        finding: resolved,
        runId: "run-1",
        at: at(2),
      },
      {
        kind: "finding-applied",
        round: 1,
        id: resolved.id,
        runId: "run-1",
        at: at(3),
      },
      {
        kind: "loop-finished",
        stage: "converge",
        outcome: "converged",
        result: "PASSED",
        runId: "run-1",
        at: at(4),
      },
    ]);
    const prior = priorRunFindings(view);
    expect(prior).toHaveLength(1);
    expect(prior[0]?.finding.subject).toBe("SC-02");
    expect(prior[0]?.status).toBe("declined");
    expect(prior[0]?.lastDeclineReason).toBe("intended behavior");
  });
});

describe("journal persistence", () => {
  it("appends, rereads, and derives the view file", async () => {
    const dir = await root();
    const f = finding();
    await appendMemoryEvents(dir, "alpha", [
      { kind: "run-started", stage: "converge", runId: "run-1", at: at(0) },
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(1) },
    ]);
    await appendMemoryEvents(dir, "alpha", [
      {
        kind: "finding-declined",
        round: 1,
        id: f.id,
        reason: "spec already covers it",
        runId: "run-1",
        at: at(2),
      },
    ]);
    const view = await readProgramMemory(dir, "alpha");
    expect(view.findings[f.id]?.status).toBe("declined");
    // The view file is derived, human-readable output of the same reduction.
    const written = JSON.parse(
      await readFile(memoryViewPath(dir, "alpha"), "utf8"),
    ) as { findings: Record<string, { status: string }> };
    expect(written.findings[f.id]?.status).toBe("declined");
  });

  it("skips damaged journal lines instead of failing the read", async () => {
    const dir = await root();
    const f = finding();
    await appendMemoryEvents(dir, "alpha", [
      { kind: "finding-raised", round: 1, finding: f, runId: "run-1", at: at(0) },
    ]);
    await appendFile(
      memoryJournalPath(dir, "alpha"),
      'not json at all\n{"kind":42}\n',
      "utf8",
    );
    const view = await readProgramMemory(dir, "alpha");
    expect(Object.keys(view.findings)).toEqual([f.id]);
  });

  it("returns an empty view when no journal exists", async () => {
    const dir = await root();
    const view = await readProgramMemory(dir, "missing");
    expect(view.findings).toEqual({});
    expect(view.runs).toEqual([]);
  });
});

describe("attempt history and diagnoses", () => {
  it("tracks per-unit attempts and exposes the last failure", async () => {
    const { lastFailedAttempt } = await import("../src/program-memory.js");
    const events: MemoryEvent[] = [
      {
        kind: "attempt-recorded",
        unit: "build:WS-03",
        attempt: 1,
        outcome: "failed",
        reason: "verification failed",
        excerpt: "FAIL: expected 2",
        failedCommand: "npm test",
        runId: "build-1",
        at: at(0),
      },
    ];
    let view = reduceMemoryEvents("alpha", events);
    expect(lastFailedAttempt(view, "build:WS-03")?.failedCommand).toBe(
      "npm test",
    );
    expect(lastFailedAttempt(view, "build:WS-99")).toBeUndefined();

    events.push({
      kind: "attempt-recorded",
      unit: "build:WS-03",
      attempt: 1,
      outcome: "succeeded",
      runId: "build-2",
      at: at(1),
    });
    view = reduceMemoryEvents("alpha", events);
    expect(lastFailedAttempt(view, "build:WS-03")).toBeUndefined();
    expect(view.attempts["build:WS-03"]).toHaveLength(2);
  });

  it("caps attempt records per unit at the most recent eight", () => {
    const events: MemoryEvent[] = Array.from({ length: 11 }, (_, index) => ({
      kind: "attempt-recorded" as const,
      unit: "replan",
      attempt: index + 1,
      outcome: "failed" as const,
      reason: `rejection ${index + 1}`,
      runId: `replan-${index + 1}`,
      at: at(index),
    }));
    const view = reduceMemoryEvents("alpha", events);
    expect(view.attempts["replan"]).toHaveLength(8);
    expect(view.attempts["replan"]?.[0]?.reason).toBe("rejection 4");
    expect(view.attempts["replan"]?.at(-1)?.reason).toBe("rejection 11");
  });

  it("records stage diagnoses for report-less structural exits", () => {
    const view = reduceMemoryEvents("alpha", [
      {
        kind: "stage-diagnosis",
        stage: "author",
        outcome: "requires-replan",
        reason: "dependency cycle",
        detail: "WS-01 -> WS-02 -> WS-01",
        runId: "author-1",
        at: at(0),
      },
    ]);
    expect(view.diagnoses).toHaveLength(1);
    expect(view.diagnoses[0]?.detail).toContain("WS-02");
  });
});
