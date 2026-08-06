import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkstreams } from "../src/validate.js";

const temporaryRoots: string[] = [];

async function fixture(
  manifest: Record<string, unknown>,
  specs: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(specs)) {
    const destination = join(root, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  return root;
}

function manifest(
  workstreams: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    program: { id: "alpha", name: "Alpha", status: "planning" },
    successCriteria: [{ id: "SC-01", description: "Feature works." }],
    packages: [{ name: "app", path: "src" }],
    workstreams,
  };
}

const validSpec = `# WS-01: Core

## Traceability
- SC-01

## Dependencies
None.

## Files Touched
- (NEW) \`src/core.ts\`

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Validation exits successfully.
`;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("validateWorkstreams", () => {
  it("passes a structurally complete program", async () => {
    const root = await fixture(
      manifest([
        {
          id: "WS-01",
          name: "Core",
          taskFile: "tasks/alpha/ws-01.md",
          status: "not_started",
          dependencies: [],
          packages: ["app"],
        },
      ]),
      { "tasks/alpha/ws-01.md": validSpec },
    );

    const report = await validateWorkstreams(root, "alpha");

    expect(report.result).toBe("PASSED");
    expect(report.findings).toEqual([]);
    expect(report.coverage).toEqual([
      { successCriterionId: "SC-01", workstreamIds: ["WS-01"] },
    ]);
  });

  it("blocks unknown dependencies, cycles, and incomplete file annotations", async () => {
    const root = await fixture(
      manifest([
        {
          id: "WS-01",
          name: "One",
          taskFile: "tasks/alpha/ws-01.md",
          status: "not_started",
          dependencies: ["WS-02", "WS-99"],
          packages: ["app"],
        },
        {
          id: "WS-02",
          name: "Two",
          taskFile: "tasks/alpha/ws-02.md",
          status: "not_started",
          dependencies: ["WS-01"],
          packages: [],
        },
      ]),
      {
        "tasks/alpha/ws-01.md": validSpec.replace(
          "(NEW) `src/core.ts`",
          "`src/core.ts`",
        ),
        "tasks/alpha/ws-02.md": validSpec.replaceAll("WS-01", "WS-02"),
      },
    );

    const report = await validateWorkstreams(root, "alpha");
    const codes = report.findings.map(({ code }) => code);

    expect(report.result).toBe("FAILED");
    expect(codes).toContain("dependency-unknown");
    expect(codes).toContain("dependency-cycle");
    expect(codes).toContain("files-annotation-missing");
  });

  it("accepts annotation notes and non-bullet commentary in Files Touched", async () => {
    const spec = validSpec.replace(
      "## Files Touched\n- (NEW) `src/core.ts`",
      `## Files Touched
- \`src/core.ts\` (NEW)
- \`src/props.ts\` (MODIFY — extend props)
1. \`src/routes.ts\` (MODIFY)

> UNTOUCHED for context: \`src/legacy.ts\` stays as is.
Prose mentioning \`src/other.ts\` is also fine.`,
    );
    const root = await fixture(
      manifest([
        {
          id: "WS-01",
          name: "Core",
          taskFile: "tasks/alpha/ws-01.md",
          status: "not_started",
          dependencies: [],
          packages: ["app"],
        },
      ]),
      { "tasks/alpha/ws-01.md": spec },
    );

    const report = await validateWorkstreams(root, "alpha");

    expect(report.findings).toEqual([]);
    expect(report.result).toBe("PASSED");
  });

  it("rejects task paths outside the project root", async () => {
    const root = await fixture(
      manifest([
        {
          id: "WS-01",
          name: "Unsafe",
          taskFile: "../outside.md",
          status: "not_started",
          dependencies: [],
          packages: ["app"],
        },
      ]),
      {},
    );

    const report = await validateWorkstreams(root, "alpha");

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "task-path-unsafe" }),
      ]),
    );
  });

  it("rejects duplicate identities and a mismatched manifest program ID", async () => {
    const duplicate = manifest([
      {
        id: "WS-01",
        name: "One",
        taskFile: "tasks/alpha/ws-01.md",
        status: "not_started",
        dependencies: [],
        packages: ["app"],
      },
      {
        id: "WS-01",
        name: "Duplicate",
        taskFile: "tasks/alpha/ws-01.md",
        status: "not_started",
        dependencies: [],
        packages: [],
      },
    ]);
    duplicate.program = { id: "beta", name: "Beta", status: "planning" };
    const root = await fixture(duplicate, {
      "tasks/alpha/ws-01.md": validSpec,
    });

    const report = await validateWorkstreams(root, "alpha");
    const codes = report.findings.map(({ code }) => code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "program-id-mismatch",
        "workstream-duplicate",
        "task-file-duplicate",
      ]),
    );
  });
});
