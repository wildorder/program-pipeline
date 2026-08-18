import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewCriteria } from "../src/criteria.js";
import {
  parseStage,
  runProgram,
  stagesFor,
  type RunStage,
} from "../src/run-program.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function spec(workstreamId: string): string {
  return `# ${workstreamId}: Example

## Traceability
- SC-01

## Checkpoint Safety
The repository remains green without work from a later workstream.

## Files Touched
- \`src/example.ts\` (NEW)

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Verification exits successfully.
`;
}

function initGitRepo(root: string): void {
  const run = (...args: string[]): void => {
    spawnSync("git", args, { cwd: root, stdio: "ignore" });
  };
  run("init");
  run("config", "user.email", "runner@example.com");
  run("config", "user.name", "Runner");
  run("add", "-A");
  run("commit", "-m", "initial");
}

interface FixtureOptions {
  requireCriteriaApproval?: boolean;
  /** Break WS-01's spec so deterministic validation fails. */
  brokenSpec?: boolean;
  git?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-run-"));
  temporaryRoots.push(root);

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "example.ts"), "export {};\n", "utf8");
  await writeFile(join(root, ".gitignore"), "build-logs/\n", "utf8");

  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(
      {
        program: { id: "alpha", name: "Alpha", status: "planning" },
        successCriteria: [{ id: "SC-01", description: "Feature works." }],
        workstreams: [
          {
            id: "WS-01",
            name: "Core",
            taskFile: "tasks/alpha/ws-01.md",
            status: "not_started",
            dependencies: [],
            scope: { summary: "Core behavior." },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "tasks", "alpha", "ws-01.md"),
    options.brokenSpec
      ? "# WS-01: Core\n\n## Goal\nNo required sections at all.\n"
      : spec("WS-01"),
    "utf8",
  );
  await writeFile(
    join(root, "pipeline.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pipelineVersion: "0.1.0",
        visionPath: "docs/vision.md",
        requireApprovalBeforeBuild: false,
        agent: { command: "fake-agent", args: [] },
        authorAgent: { command: "author-agent", args: [] },
        validatorAgent: { command: "codex", args: ["exec"] },
        verify: { test: "npm test" },
        ...(options.requireCriteriaApproval
          ? { build: { requireCriteriaApproval: true } }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (options.git !== false) initGitRepo(root);
  return root;
}

const refuse = async (): Promise<never> => {
  throw new Error("no agent should have been spawned");
};

describe("parseStage", () => {
  it("accepts every declared stage and rejects anything else", () => {
    expect(parseStage("author")).toBe("author");
    expect(parseStage("  AS-BUILT ")).toBe("as-built");
    expect(() => parseStage("deploy")).toThrow("Unknown stage");
  });
});

describe("stagesFor", () => {
  it("skips the advisory review by default", () => {
    // It never blocks and costs an agent, so the default path to a built
    // program does not pay for it.
    expect(stagesFor({})).toEqual([
      "author",
      "validate",
      "converge",
      "criteria",
      "build",
      "as-built",
    ]);
  });

  it("places the review after convergence when asked for", () => {
    expect(stagesFor({ review: true })).toEqual([
      "author",
      "validate",
      "converge",
      "review",
      "criteria",
      "build",
      "as-built",
    ]);
  });

  it("resumes from a stage", () => {
    expect(stagesFor({ from: "build" })).toEqual(["build", "as-built"]);
  });

  it("stops after a stage", () => {
    expect(stagesFor({ to: "converge" })).toEqual([
      "author",
      "validate",
      "converge",
    ]);
  });

  it("narrows from both ends", () => {
    expect(stagesFor({ from: "validate", to: "criteria" })).toEqual([
      "validate",
      "converge",
      "criteria",
    ]);
  });

  it("returns nothing when the range is inverted or excluded", () => {
    expect(stagesFor({ from: "build", to: "author" })).toEqual([]);
    // review is not in the default sequence, so --from review without
    // --review selects nothing rather than silently running everything.
    expect(stagesFor({ from: "review" as RunStage })).toEqual([]);
  });
});

describe("runProgram", () => {
  it("refuses to start on a dirty tree, before any stage runs", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "stray.ts"), "export {};\n", "utf8");

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: refuse,
    });

    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("uncommitted change");
    // The guard is hoisted to the front so this is not discovered at stage five.
    expect(result.stages).toEqual([]);
  });

  it("allows a dirty tree when commits are disabled", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "stray.ts"), "export {};\n", "utf8");

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "validate",
      to: "validate",
      commit: false,
      agentRunner: refuse,
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.stages.map(({ stage }) => stage)).toEqual(["validate"]);
  });

  it("fails on deterministic validation before spending an agent", async () => {
    const root = await fixture({ brokenSpec: true });

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "validate",
      agentRunner: refuse,
    });

    // Cheap stage first: the same defect found by the convergence loop would
    // have cost two agent invocations to discover.
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("Deterministic validation failed");
    expect(result.stages.map(({ stage }) => stage)).toEqual(["validate"]);
  });

  it("stops at the criteria gate when it is switched on", async () => {
    const root = await fixture({ requireCriteriaApproval: true });

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      agentRunner: refuse,
    });

    expect(result.result).toBe("STOPPED");
    expect(result.reason).toContain("--approve");
    expect(result.reason).toContain("--from criteria");
    // The document is still produced, so there is something to review.
    await expect(
      readFile(join(root, "docs", "programs", "alpha-criteria.md"), "utf8"),
    ).resolves.toContain("Acceptance criteria: alpha");
  });

  it("carries on past criteria once they are approved", async () => {
    const root = await fixture({ requireCriteriaApproval: true });
    // Approving writes the hash into the manifest, leaving the tree dirty.
    // The documented resume path has to survive exactly that.
    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      to: "criteria",
      agentRunner: refuse,
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.stages[0]?.result).toBe("APPROVED");
    // And the approval it just confirmed is committed, not left loose.
    expect(result.stages[0]?.commit).toBeDefined();
  });

  it("still refuses when the dirty paths are the user's own work", async () => {
    const root = await fixture({ requireCriteriaApproval: true });
    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });
    await writeFile(join(root, "src", "stray.ts"), "export {};\n", "utf8");

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      agentRunner: refuse,
    });

    // The exemption covers the runner's own artifacts, nothing else.
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("uncommitted change");
    expect(result.reason).toContain("stray.ts");
  });

  it("does not stop at criteria when the gate is off", async () => {
    const root = await fixture();

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      to: "criteria",
      agentRunner: refuse,
    });

    // The document is produced either way; only the gate stops the run.
    expect(result.result).toBe("COMPLETE");
    expect(result.stages[0]?.result).toBe("REVIEW_REQUIRED");
  });

  it("commits what a stage produced", async () => {
    const root = await fixture();

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      to: "criteria",
      agentRunner: refuse,
    });

    expect(result.stages[0]?.commit).toBeDefined();
    const log = spawnSync("git", ["log", "--oneline", "-1"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("acceptance criteria");
  });

  it("skips commits outside a git repository", async () => {
    const root = await fixture({ git: false });

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "criteria",
      to: "criteria",
      agentRunner: refuse,
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.stages[0]?.commit).toBeUndefined();
  });

  it("reports an impossible stage range instead of running everything", async () => {
    const root = await fixture();

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "build",
      to: "author",
      agentRunner: refuse,
    });

    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("No stages to run");
    expect(result.stages).toEqual([]);
  });

  it("automatically refreshes missing semantic convergence before --from build", async () => {
    const root = await fixture({ git: false });
    const prompts: string[] = [];
    const progress: string[] = [];

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "build",
      to: "build",
      commit: false,
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        if (invocation.prompt.includes('"checkpointAssessments"')) {
          return {
            exitCode: 0,
            output: `\`\`\`json
{"checkpointAssessments":[{"workstreamId":"WS-01","status":"safe","reason":"All configured verification remains green after WS-01 alone."}],"findings":[]}
\`\`\``,
          };
        }
        return { exitCode: 0, output: "implemented" };
      },
      verifyRunner: async () => ({ exitCode: 0, output: "ok" }),
      onProgress: (line) => progress.push(line),
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.stages.map(({ stage }) => stage)).toEqual([
      "validate",
      "converge",
      "build",
    ]);
    expect(progress.join("\n")).toContain("automatically running validate and converge");
    expect(prompts).toHaveLength(2);
  });

  it("halts --from build before implementation when the refreshed checkpoint is unsafe", async () => {
    const root = await fixture({ git: false });
    let agentCalls = 0;

    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "build",
      to: "build",
      commit: false,
      agentRunner: async () => {
        agentCalls += 1;
        return {
          exitCode: 0,
          output: `\`\`\`json
{"checkpointAssessments":[{"workstreamId":"WS-01","status":"unsafe","reason":"WS-01 deletes a contract while unmigrated consumers remain."}],"findings":[]}
\`\`\``,
        };
      },
      verifyRunner: async () => ({ exitCode: 0, output: "must not run" }),
    });

    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("needs replanning");
    expect(result.stages.map(({ stage }) => stage)).toEqual([
      "validate",
      "converge",
    ]);
    expect(agentCalls).toBe(1);
  });
});
