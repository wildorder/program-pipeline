import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCriteria,
  criteriaGateFailure,
  criteriaHash,
  renderCriteriaDocument,
  reviewCriteria,
  type WorkstreamCriteria,
} from "../src/criteria.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function spec(workstreamId: string, criteria: string, goal = "Does a thing."): string {
  return `# ${workstreamId}: Example

## Goal
${goal}

## Traceability
- SC-01

## Checkpoint Safety
The repository remains green without work from a later workstream.

## Files Touched
- \`src/example.ts\` (NEW)

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
${criteria}
`;
}

interface FixtureOptions {
  /** Workstream id -> acceptance criteria body, or null for no section. */
  criteria?: Record<string, string | null>;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-criteria-"));
  temporaryRoots.push(root);

  const criteria = options.criteria ?? {
    "WS-01": "1. The core module exports `run()`.",
    "WS-02": "1. The API returns 200 for a valid request.",
  };
  const ids = Object.keys(criteria);

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(
      {
        program: { id: "alpha", name: "Alpha", status: "planning" },
        successCriteria: [{ id: "SC-01", description: "Works." }],
        workstreams: ids.map((id) => ({
          id,
          name: `Workstream ${id}`,
          taskFile: `tasks/alpha/${id.toLowerCase()}.md`,
          status: "not_started",
          dependencies: [],
          scope: { summary: `${id} scope summary.` },
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const id of ids) {
    const body = criteria[id];
    const markdown =
      body === null
        ? `# ${id}: Example\n\n## Goal\nNo criteria here.\n`
        : spec(id, body ?? "");
    await writeFile(
      join(root, "tasks", "alpha", `${id.toLowerCase()}.md`),
      markdown,
      "utf8",
    );
  }
  return root;
}

const manifestOf = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(join(root, "docs", "programs", "alpha-manifest.json"), "utf8"),
  ) as Record<string, unknown>;

const entry = (id: string, criteria?: string): WorkstreamCriteria => ({
  id,
  name: `Workstream ${id}`,
  taskFile: `tasks/alpha/${id.toLowerCase()}.md`,
  ...(criteria === undefined ? {} : { criteria }),
});

describe("criteriaHash", () => {
  it("ignores manifest ordering", () => {
    const a = [entry("WS-01", "1. One."), entry("WS-02", "1. Two.")];
    const b = [entry("WS-02", "1. Two."), entry("WS-01", "1. One.")];
    expect(criteriaHash(a)).toBe(criteriaHash(b));
  });

  it("ignores line endings and trailing whitespace", () => {
    expect(criteriaHash([entry("WS-01", "1. One.  \r\n2. Two.")])).toBe(
      criteriaHash([entry("WS-01", "1. One.\n2. Two.")]),
    );
  });

  it("changes when a criterion changes", () => {
    expect(criteriaHash([entry("WS-01", "1. One.")])).not.toBe(
      criteriaHash([entry("WS-01", "1. One, but different.")])
    );
  });

  it("changes when a workstream gains or loses criteria", () => {
    const base = criteriaHash([entry("WS-01", "1. One.")]);
    expect(criteriaHash([entry("WS-01", "1. One."), entry("WS-02", "1. Two.")])).not.toBe(base);
    expect(criteriaHash([entry("WS-01")])).not.toBe(base);
  });
});

describe("collectCriteria", () => {
  it("pulls the Acceptance Criteria section from every spec", async () => {
    const root = await fixture();
    const status = await collectCriteria(root, "alpha");

    expect(status.workstreams.map(({ id }) => id)).toEqual(["WS-01", "WS-02"]);
    expect(status.workstreams[0]?.criteria).toBe(
      "1. The core module exports `run()`.",
    );
    expect(status.workstreams[0]?.scopeSummary).toBe("WS-01 scope summary.");
    expect(status.approved).toBe(false);
    expect(status.lapsed).toBe(false);
    expect(status.missing).toEqual([]);
  });

  it("reports workstreams whose spec has no criteria section", async () => {
    const root = await fixture({
      criteria: { "WS-01": "1. Fine.", "WS-02": null },
    });
    const status = await collectCriteria(root, "alpha");
    expect(status.missing).toEqual(["WS-02"]);
  });

  it("is unaffected by spec edits outside the criteria section", async () => {
    const root = await fixture();
    const before = (await collectCriteria(root, "alpha")).hash;
    await writeFile(
      join(root, "tasks", "alpha", "ws-01.md"),
      spec("WS-01", "1. The core module exports `run()`.", "Rewritten goal."),
      "utf8",
    );
    // A reworded goal is not a change to what "done" means.
    expect((await collectCriteria(root, "alpha")).hash).toBe(before);
  });
});

describe("renderCriteriaDocument", () => {
  it("says how to approve when nothing is approved yet", async () => {
    const root = await fixture();
    const document = renderCriteriaDocument(await collectCriteria(root, "alpha"));
    expect(document).toContain("**Not approved.**");
    expect(document).toContain("criteria alpha --approve");
    expect(document).toContain("## WS-01: Workstream WS-01");
    expect(document).toContain("1. The core module exports `run()`.");
  });

  it("flags a lapsed approval with both hashes", async () => {
    const root = await fixture();
    const status = await collectCriteria(root, "alpha");
    const document = renderCriteriaDocument({
      ...status,
      approval: { hash: "stale000", approvedAt: "2026-01-01T00:00:00.000Z" },
      approved: false,
      lapsed: true,
    });
    expect(document).toContain("**Approval lapsed.**");
    expect(document).toContain("stale000");
    expect(document).toContain(status.hash);
  });

  it("calls out workstreams with nothing to approve", async () => {
    const root = await fixture({
      criteria: { "WS-01": "1. Fine.", "WS-02": null },
    });
    const document = renderCriteriaDocument(await collectCriteria(root, "alpha"));
    expect(document).toContain("no Acceptance Criteria section");
    expect(document).toContain("WS-02");
  });
});

describe("reviewCriteria", () => {
  it("writes the document and asks for review", async () => {
    const root = await fixture();
    const result = await reviewCriteria({ cwd: root, programId: "alpha" });

    expect(result.result).toBe("REVIEW_REQUIRED");
    expect(result.lapsed).toBe(false);
    await expect(
      readFile(join(root, "docs", "programs", "alpha-criteria.md"), "utf8"),
    ).resolves.toContain("# Acceptance criteria: alpha");
  });

  it("records approval in the manifest and reports APPROVED", async () => {
    const root = await fixture();
    const approved = await reviewCriteria({
      cwd: root,
      programId: "alpha",
      approve: true,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(approved.result).toBe("APPROVED");
    expect(approved.approvedAt).toBe("2026-08-15T12:00:00.000Z");
    const manifest = (await manifestOf(root)) as {
      criteriaApproval?: { hash: string; approvedAt: string };
      program: { name: string };
    };
    expect(manifest.criteriaApproval?.hash).toBe(approved.hash);
    // Recording approval must not disturb the rest of the manifest.
    expect(manifest.program.name).toBe("Alpha");

    const again = await reviewCriteria({ cwd: root, programId: "alpha" });
    expect(again.result).toBe("APPROVED");
  });

  it("lapses the approval when a criterion is edited afterwards", async () => {
    const root = await fixture();
    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });

    await writeFile(
      join(root, "tasks", "alpha", "ws-01.md"),
      spec("WS-01", "1. The core module exports `run()` and `stop()`."),
      "utf8",
    );

    const result = await reviewCriteria({ cwd: root, programId: "alpha" });
    expect(result.result).toBe("REVIEW_REQUIRED");
    expect(result.lapsed).toBe(true);
    expect(result.reason).toContain("lapsed");
  });

  it("aborts when the program has no manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-criteria-"));
    temporaryRoots.push(root);
    const result = await reviewCriteria({ cwd: root, programId: "ghost" });
    expect(result.result).toBe("ABORTED");
  });
});

describe("criteriaGateFailure", () => {
  it("blocks when the criteria were never approved", async () => {
    const root = await fixture();
    await expect(criteriaGateFailure(root, "alpha")).resolves.toContain(
      "have not been approved",
    );
  });

  it("passes once they are approved", async () => {
    const root = await fixture();
    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });
    await expect(criteriaGateFailure(root, "alpha")).resolves.toBeUndefined();
  });

  it("blocks again after the criteria change under an approval", async () => {
    const root = await fixture();
    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });
    await writeFile(
      join(root, "tasks", "alpha", "ws-02.md"),
      spec("WS-02", "1. The API returns 201 for a valid request."),
      "utf8",
    );
    await expect(criteriaGateFailure(root, "alpha")).resolves.toContain(
      "changed after they were approved",
    );
  });

  it("reports rather than throws when the manifest is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-criteria-"));
    temporaryRoots.push(root);
    await expect(criteriaGateFailure(root, "ghost")).resolves.toContain(
      "Could not check",
    );
  });
});
