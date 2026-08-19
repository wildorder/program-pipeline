import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewCriteria } from "../src/criteria.js";
import { fingerprint } from "../src/findings.js";
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
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n\nProgram plan.\n",
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

async function setMode(root: string, mode: "atomic" | "orchestrated"): Promise<void> {
  const path = join(root, "docs", "programs", "alpha-manifest.json");
  const value = JSON.parse(await readFile(path, "utf8")) as {
    program: Record<string, unknown>;
  };
  value.program.executionMode = mode;
  value.program.executionModeReason = mode === "atomic"
    ? "one cohesive working set and green checkpoint"
    : "checkpoint graph is required";
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("parseStage", () => {
  it("accepts every declared stage and rejects anything else", () => {
    expect(parseStage("plan-audit")).toBe("plan-audit");
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
      "plan-audit",
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
      "plan-audit",
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
      "plan-audit",
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
  it("uses one semantic round for a planner-selected atomic program", async () => {
    const root = await fixture({ git: false });
    await setMode(root, "atomic");
    const prompts: string[] = [];
    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "converge",
      to: "converge",
      commit: false,
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        return {
          exitCode: 0,
          output: `\`\`\`json
{"checkpointAssessments":[{"workstreamId":"WS-01","status":"safe","reason":"The whole program leaves every configured verification command green."}],"findings":[],"classAnalyses":[],"requirementsChangeRequested":false,"criteriaPatches":[]}
\`\`\``,
        };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(result.executionMode).toBe("atomic");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("round 1 of 1");
  });

  it("lets atomic mode apply one bounded spec repair without demanding a confirmation round", async () => {
    const root = await fixture({ git: false });
    await setMode(root, "atomic");
    const finding = {
      severity: "major" as const,
      category: "test-quality" as const,
      subject: "Tests case 1",
      message: "The assertion does not discriminate a wrong implementation.",
      evidence: [{ kind: "concern" as const, named: "non-discriminating assertion" }],
      workstreamId: "WS-01",
      requiresReplan: false,
    };
    const id = fingerprint(finding);
    let calls = 0;
    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "converge",
      to: "converge",
      commit: false,
      agentRunner: async () => {
        calls += 1;
        if (calls === 1) return {
          exitCode: 0,
          output: `\`\`\`json\n${JSON.stringify({ checkpointAssessments: [{ workstreamId: "WS-01", status: "safe", reason: "The whole program remains green." }], findings: [finding], classAnalyses: [{ subject: finding.subject, scope: "isolated", rootCause: "one weak assertion", affectedSubjects: ["case 1"], checkedSubjects: ["case 1"], completenessBasis: "the spec has one test case" }], requirementsChangeRequested: false, criteriaPatches: [] })}\n\`\`\``,
        };
        return {
          exitCode: 0,
          output: `\`\`\`json\n${JSON.stringify({ applied: [id], rejected: [], resolutionProofs: [{ id, changedPaths: ["tasks/alpha/ws-01.md"], checkedSubjects: ["case 1"], completenessBasis: "the spec has one test case" }] })}\n\`\`\``,
        };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(calls).toBe(2);
    expect(result.stages[0]?.result).toBe("PASSED");
  });

  it("refuses to force a multi-workstream manifest through atomic routing", async () => {
    const root = await fixture({ git: false });
    const path = join(root, "docs", "programs", "alpha-manifest.json");
    const value = JSON.parse(await readFile(path, "utf8")) as { workstreams: Array<Record<string, unknown>> };
    value.workstreams.push({ id: "WS-02", name: "Second", taskFile: "tasks/alpha/ws-02.md", status: "not_started", dependencies: [] });
    await writeFile(path, JSON.stringify(value), "utf8");
    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      executionMode: "atomic",
      commit: false,
      agentRunner: refuse,
    });
    expect(result.result).toBe("FAILED");
    expect(result.executionMode).toBe("atomic");
    expect(result.reason).toContain("exactly one whole-program workstream");
  });

  it("re-audits an automatic replan before authoring", async () => {
    const root = await fixture({ git: false });
    const calls: string[] = [];
    let auditCalls = 0;
    let authorCalls = 0;
    const result = await runProgram({
      cwd: root,
      programId: "alpha",
      from: "plan-audit",
      to: "author",
      commit: false,
      agentRunner: async (invocation) => {
        calls.push(invocation.prompt);
        if (invocation.prompt.includes("# Audit the executable plan")) {
          auditCalls += 1;
          const conflict = auditCalls === 1;
          return {
            exitCode: 0,
            output: `\`\`\`json\n${JSON.stringify({
              criterionAssessments: [{ criterionId: "SC-01", status: conflict ? "conflict" : "satisfiable", reason: conflict ? "the blanket contract does not match the actual API" : "verified after replan", checkedSubjects: ["public API"], completenessBasis: "complete exported API" }],
              findings: conflict ? [{ severity: "blocker", category: "acceptance-criteria", subject: "SC-01", message: "The blanket contract is not implementable.", evidence: [{ kind: "concern", named: "API mismatch" }], requiresReplan: true }] : [],
              classAnalyses: conflict ? [{ subject: "SC-01", scope: "systemic", rootCause: "conceptual family ignores API shapes", affectedSubjects: ["public API"], checkedSubjects: ["public API"], completenessBasis: "complete exported API" }] : [],
              requirementsChangeRequested: false,
              criteriaPatches: [],
            })}\n\`\`\``,
          };
        }
        if (invocation.prompt.includes("headless replanner")) {
          await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\n\nReplanned against the public API.\n", "utf8");
          return {
            exitCode: 0,
            output: `\`\`\`json\n{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"public API","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"reconciled against the exported API"}]}],"completenessBasis":"complete exported API"}]}\n\`\`\`\n\`\`\`summary\nClosed the class. REPLAN_COMPLETE\n\`\`\``,
          };
        }
        if (invocation.prompt.includes("# Author the workstream spec")) {
          authorCalls += 1;
          await writeFile(join(root, "tasks", "alpha", "ws-01.md"), spec("WS-01"), "utf8");
          return { exitCode: 0, output: "```json\n{\"dependencies\":[],\"needs\":[],\"unmet\":[],\"replan\":[]}\n```" };
        }
        throw new Error("unexpected agent prompt");
      },
    });

    expect(result.result, result.reason).toBe("COMPLETE");
    expect(auditCalls).toBe(2);
    expect(authorCalls).toBe(1);
    expect(result.stages.map(({ stage, result: stageResult }) => [stage, stageResult])).toEqual([
      ["plan-audit", "REQUIRES_REPLAN"],
      ["plan-audit", "PASSED"],
      ["author", "COMPLETE"],
    ]);
    expect(calls.filter((prompt) => prompt.includes("headless replanner"))).toHaveLength(1);
  });

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
    const progress: string[] = [];

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
      onProgress: (line) => progress.push(line),
    });

    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("WS-01 checkpoint safety");
    expect(result.reason).toContain(
      "WS-01 deletes a contract while unmigrated consumers remain.",
    );
    expect(result.reason).toContain("alpha-replan.json");
    expect(result.reason).toContain("/plan-program alpha");
    expect(progress.join("\n")).toContain("requires replanning:");
    expect(progress.join("\n")).toContain("replan input:");
    const report = JSON.parse(
      await readFile(
        join(root, "docs", "programs", "alpha-replan.json"),
        "utf8",
      ),
    ) as { replanFindings: Array<{ message: string }> };
    expect(report.replanFindings[0]?.message).toBe(
      "WS-01 deletes a contract while unmigrated consumers remain.",
    );
    expect(result.stages.map(({ stage }) => stage)).toEqual([
      "validate",
      "converge",
    ]);
    // One critic call plus two bounded transactional replanner attempts; build
    // is never invoked while the checkpoint remains unsafe.
    expect(agentCalls).toBe(3);
  });
});
