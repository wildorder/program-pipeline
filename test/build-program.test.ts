import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProgram,
  classifyAgentOutput,
  sanitizedEnvironment,
  type AgentInvocation,
  type CommandResult,
} from "../src/build-program.js";
import {
  convergenceReceiptPath,
  writeConvergenceReceipt,
} from "../src/convergence-receipt.js";
import { reviewCriteria } from "../src/criteria.js";
import { loadPipelineConfig } from "../src/pipeline-config.js";

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
- (NEW) \`src/example.ts\`

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Verification exits successfully.
`;
}

interface FixtureOptions {
  requireApproval?: boolean;
  verify?: Record<string, string>;
  agent?: Record<string, unknown>;
  recoveryAgent?: Record<string, unknown>;
  statuses?: Record<string, string>;
  maxRecoveryAttempts?: number;
  verifyRetries?: number;
  requireCriteriaApproval?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-build-"));
  temporaryRoots.push(root);

  const workstreams = [
    {
      id: "WS-01",
      name: "Core",
      taskFile: "tasks/alpha/ws-01.md",
      status: options.statuses?.["WS-01"] ?? "not_started",
      dependencies: [],
      packages: ["app"],
    },
    {
      id: "WS-02",
      name: "API",
      taskFile: "tasks/alpha/ws-02.md",
      status: options.statuses?.["WS-02"] ?? "not_started",
      dependencies: ["WS-01"],
      packages: [],
    },
  ];

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  // The specs declare (NEW) src/example.ts; pre-create it so tests whose
  // fake agents write no files still satisfy the declared-files guard.
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "example.ts"), "export {};\n", "utf8");
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(
      {
        program: { id: "alpha", name: "Alpha", status: "planning" },
        successCriteria: [{ id: "SC-01", description: "Feature works." }],
        packages: [{ name: "app", path: "src" }],
        workstreams,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  // As `init-project` leaves a real project: the runner's log dir is
  // gitignored, which git refuses to see named in an `add` pathspec.
  await writeFile(join(root, ".gitignore"), "build-logs/\n", "utf8");
  await writeFile(join(root, "tasks", "alpha", "ws-01.md"), spec("WS-01"), "utf8");
  await writeFile(join(root, "tasks", "alpha", "ws-02.md"), spec("WS-02"), "utf8");
  await writeFile(
    join(root, "pipeline.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pipelineVersion: "0.1.0",
        visionPath: "docs/vision.md",
        requireApprovalBeforeBuild: options.requireApproval ?? false,
        agent: options.agent ?? { command: "fake-agent", args: ["--model", "sonnet"] },
        ...(options.recoveryAgent === undefined
          ? {}
          : { recoveryAgent: options.recoveryAgent }),
        validatorAgent: { command: "codex", args: ["exec", "--model", "gpt-sol"] },
        models: { author: "claude-code/opus", validator: "gpt-sol" },
        verify: options.verify ?? { test: "npm test" },
        ...(options.maxRecoveryAttempts === undefined &&
        options.verifyRetries === undefined &&
        options.requireCriteriaApproval === undefined
          ? {}
          : {
              build: {
                ...(options.maxRecoveryAttempts === undefined
                  ? {}
                  : { maxRecoveryAttempts: options.maxRecoveryAttempts }),
                ...(options.verifyRetries === undefined
                  ? {}
                  : { verifyRetries: options.verifyRetries }),
                ...(options.requireCriteriaApproval === undefined
                  ? {}
                  : {
                      requireCriteriaApproval: options.requireCriteriaApproval,
                    }),
              },
            }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeConvergenceReceipt(
    root,
    "alpha",
    await loadPipelineConfig(root),
  );
  return root;
}

async function manifestStatuses(root: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(
    await readFile(join(root, "docs", "programs", "alpha-manifest.json"), "utf8"),
  ) as { workstreams: Array<{ id: string; status: string }> };
  return Object.fromEntries(
    manifest.workstreams.map(({ id, status }) => [id, status]),
  );
}

async function programStatus(root: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(root, "docs", "programs", "alpha-manifest.json"), "utf8"),
  ) as { program: { status: string } };
  return manifest.program.status;
}

const pass = async (): Promise<CommandResult> => ({ exitCode: 0, output: "ok" });

function initGitRepo(root: string): void {
  const git = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init"]);
  // Local identity: the runner's own commits use the repository's config.
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-m", "baseline"]);
}

/** Working-tree changes, ignoring the runner's own log output. */
async function dirtyEntries(root: string): Promise<string[]> {
  const result = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("build-logs/"));
}

function gitLog(root: string): string[] {
  const result = spawnSync("git", ["log", "--format=%s"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
}

describe("sanitizedEnvironment", () => {
  it("strips agent-session markers and keeps everything else", () => {
    const env = sanitizedEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "12345",
      CURSOR_AGENT: "1",
      CURSOR_TRACE_ID: "abc",
      ANTHROPIC_MODEL: "sonnet",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      ANTHROPIC_MODEL: "sonnet",
    });
  });
});

describe("classifyAgentOutput", () => {
  it("recognizes explicit unverified and terminal provider outcomes", () => {
    expect(classifyAgentOutput('Submission recorded (unverified)\n{"verified":false}')).toEqual({
      kind: "unverified",
      reason: "the agent explicitly reported that its submission was unverified",
    });
    expect(
      classifyAgentOutput("Error: The model hit the maximum output token limit"),
    ).toMatchObject({ kind: "terminal" });
  });

  it("does not classify status text echoed far from the terminal output", () => {
    expect(
      classifyAgentOutput(
        `Submission recorded (unverified)${".".repeat(4_100)}\nordinary completion`,
      ),
    ).toBeUndefined();
  });
});

describe("buildProgram", () => {
  it("runs workstreams in dependency order, verifies each, and writes status back", async () => {
    const root = await fixture();
    const agentPrompts: string[] = [];
    const verifyCalls: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation: AgentInvocation) => {
        agentPrompts.push(invocation.prompt);
        return { exitCode: 0, output: "agent done" };
      },
      verifyRunner: async (command) => {
        verifyCalls.push(command);
        return pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[0]).toContain("WS-01");
    expect(agentPrompts[1]).toContain("WS-02");
    expect(agentPrompts[0]).toContain("npm test");
    expect(agentPrompts[0]).toContain(
      'tests, fixtures, imports, types, and lint rules',
    );
    expect(agentPrompts[0]).toContain(
      "Do not report completion or submit while any command is failing",
    );
    expect(verifyCalls).toEqual(["npm test", "npm test"]);
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "complete",
      "WS-02": "complete",
    });
    await expect(programStatus(root)).resolves.toBe("complete");

    expect(report.eventsPath).toBeDefined();
    const events = (await readFile(report.eventsPath as string, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map(({ event }) => event)).toEqual([
      "build-start",
      "commit-disabled",
      "tree-guard-disabled",
      "workstream-start",
      "agent-start",
      "agent-exit",
      "agent-summary",
      "verify-start",
      "verify-result",
      "workstream-complete",
      "workstream-start",
      "agent-start",
      "agent-exit",
      "agent-summary",
      "verify-start",
      "verify-result",
      "workstream-complete",
      "build-complete",
    ]);
  });

  it("does not trust the agent exit code and recovers once on verification failure", async () => {
    // verifyRetries: 0 so the verify failure reaches the recovery path
    // instead of being absorbed by the in-attempt retry.
    const root = await fixture({ maxRecoveryAttempts: 1, verifyRetries: 0 });
    let verifyAttempts = 0;
    const prompts: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        return { exitCode: 0, output: "claims success" };
      },
      verifyRunner: async () => {
        verifyAttempts += 1;
        return verifyAttempts === 1
          ? { exitCode: 1, output: "1 test failed" }
          : pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "complete",
      attempts: 2,
    });
    expect(prompts[1]).toContain("failed independent verification");
    expect(prompts[1]).toContain("1 test failed");
  });

  it("uses a dedicated recovery agent after independent verification fails", async () => {
    const root = await fixture({
      maxRecoveryAttempts: 1,
      recoveryAgent: {
        command: "recovery-agent",
        args: ["--model", "strong"],
        promptMode: "argument",
      },
    });
    const invocations: AgentInvocation[] = [];
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        invocations.push(invocation);
        return pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { exitCode: 1, output: "compile error" }
          : pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.recoveryAgent).toBe("recovery-agent --model strong");
    expect(invocations.slice(0, 2).map(({ command }) => command)).toEqual([
      "fake-agent",
      "recovery-agent",
    ]);
    expect(invocations[1]).toMatchObject({ promptMode: "argument" });
  });

  it("does not verify an exit-zero submission the agent explicitly marked unverified", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });
    let agentCalls = 0;
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return agentCalls === 1
          ? {
              exitCode: 0,
              output: 'Submission recorded (unverified)\n{"verified": false}',
            }
          : pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({ attempts: 2 });
    // WS-01 is verified only after recovery; WS-02 is verified normally.
    expect(verifyCalls).toBe(2);
  });

  it("stops immediately when the agent reaches a hard capacity limit", async () => {
    const root = await fixture({ maxRecoveryAttempts: 4 });
    let agentCalls = 0;
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return {
          exitCode: 0,
          output: "The model reached the maximum output token limit",
        };
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("FAILED");
    expect(report.reason).toContain("token or context limit");
    expect(agentCalls).toBe(1);
    expect(verifyCalls).toBe(0);
  });

  it("switches to a distinct recovery agent after a primary capacity failure", async () => {
    const root = await fixture({
      maxRecoveryAttempts: 2,
      recoveryAgent: {
        command: "recovery-agent",
        args: ["--model", "fallback"],
      },
    });
    const commands: string[] = [];
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        commands.push(invocation.command);
        return invocation.command === "fake-agent" && commands.length === 1
          ? {
              exitCode: 0,
              output: "The model reached the maximum output token limit",
            }
          : pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(commands.slice(0, 2)).toEqual(["fake-agent", "recovery-agent"]);
    expect(report.outcomes[0]).toMatchObject({ attempts: 2 });
    expect(verifyCalls).toBe(2);
  });

  it("does not repeatedly invoke a recovery agent that also hits capacity", async () => {
    const root = await fixture({
      maxRecoveryAttempts: 4,
      recoveryAgent: { command: "recovery-agent" },
    });
    const commands: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        commands.push(invocation.command);
        return {
          exitCode: 0,
          output: "The model reached the maximum output token limit",
        };
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("FAILED");
    expect(commands).toEqual(["fake-agent", "recovery-agent"]);
    expect(report.reason).toContain("capacity failure");
  });

  it("breaks recovery when independent verification fails identically twice", async () => {
    const root = await fixture({ maxRecoveryAttempts: 4 });
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: async () => ({
        exitCode: 1,
        output: "src/example.ts(12,3): error TS2322: Type 'x' is not assignable",
      }),
    });

    expect(report.result).toBe("FAILED");
    expect(report.reason).toContain("failed identically");
    expect(report.reason).toContain("TS2322");
    expect(agentCalls).toBe(2);
  });

  it("runs verification once by default and reports its first diagnostic", async () => {
    const root = await fixture({ maxRecoveryAttempts: 0 });
    const progress: string[] = [];
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: async () => {
        verifyCalls += 1;
        return {
          exitCode: 1,
          output: "src/example.ts:4: error TS1005: ';' expected",
        };
      },
      onProgress: (line) => progress.push(line),
    });

    expect(report.result).toBe("FAILED");
    expect(verifyCalls).toBe(1);
    expect(progress.some((line) => line.includes("TS1005"))).toBe(true);
    expect(report.reason).toContain("TS1005");
    expect(report.outcomes[0]?.logPath).toMatch(/alpha-build-.+-WS-01\.log$/);
  });

  it("reports every failing verification command to the recovery agent", async () => {
    const root = await fixture({
      maxRecoveryAttempts: 1,
      verifyRetries: 0,
      verify: {
        build: "npm run build",
        typecheck: "npm run typecheck",
        test: "npm test",
      },
    });
    const prompts: string[] = [];
    let recovered = false;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        if (prompts.length === 2) recovered = true;
        return pass();
      },
      verifyRunner: async (command) => {
        if (recovered || command === "npm test") return pass();
        return {
          exitCode: 1,
          output:
            command === "npm run build" ? "build failed" : "typecheck failed",
        };
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(prompts[1]).toContain("npm run build");
    expect(prompts[1]).toContain("build failed");
    expect(prompts[1]).toContain("npm run typecheck");
    expect(prompts[1]).toContain("typecheck failed");
    expect(prompts[1]).toContain("npm test");
    expect(prompts[1]).toContain(
      "Do not report completion or submit while any verification command is failing",
    );
  });

  it("fails an attempt when the agent changes nothing in a git repository", async () => {
    const root = await fixture();
    initGitRepo(root);

    let attempt = 0;
    const prompts: string[] = [];
    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        attempt += 1;
        prompts.push(invocation.prompt);
        // First attempt is idle; every later attempt actually edits the tree.
        if (attempt > 1) {
          await writeFile(
            join(root, "src", "example.ts"),
            `// implemented in attempt ${attempt}\n`,
            "utf8",
          );
        }
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({ id: "WS-01", attempts: 2 });
    expect(prompts[1]).toContain("made no changes to the working tree");
  });

  it("retries a failed verify command within the attempt before recovering", async () => {
    const root = await fixture({ verifyRetries: 1 });
    let verifyCalls = 0;
    const prompts: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        return pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { exitCode: 1, output: "flaky timeout" }
          : pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({ id: "WS-01", attempts: 1 });
    // No recovery prompt: WS-01 and WS-02 each got only their first prompt.
    expect(prompts).toHaveLength(2);
    // WS-01: fail then retry-pass; WS-02: pass.
    expect(verifyCalls).toBe(3);
  });

  it("accepts a no-op recovery attempt when prior work is present and verifies it", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1, verifyRetries: 0 });
    initGitRepo(root);
    let ws01Calls = 0;
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        if (invocation.prompt.includes("WS-02")) {
          await writeFile(join(root, "src", "example.ts"), "// ws-02\n", "utf8");
          return pass();
        }
        ws01Calls += 1;
        // Attempt 1 implements; the recovery attempt correctly changes nothing.
        if (ws01Calls === 1) {
          await writeFile(
            join(root, "src", "example.ts"),
            "// implemented\n",
            "utf8",
          );
        }
        return pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        // WS-01 attempt 1 fails verification (flaky); everything after passes.
        return verifyCalls === 1
          ? { exitCode: 1, output: "flaky failure" }
          : pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "complete",
      attempts: 2,
    });
  });

  it("resumes a failed workstream across runs when the work already landed", async () => {
    const root = await fixture({ maxRecoveryAttempts: 0, verifyRetries: 0 });
    initGitRepo(root);

    // Run 1: the agent implements WS-01 but verification fails.
    const first = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(
          join(root, "src", "example.ts"),
          "// implemented\n",
          "utf8",
        );
        return pass();
      },
      verifyRunner: async () => ({ exitCode: 1, output: "flaky failure" }),
    });
    expect(first.result).toBe("FAILED");

    // Run 2: the WS-01 agent finds the work in place and changes nothing;
    // the persisted baseline lets the no-op proceed to verification.
    let verifyCalls = 0;
    const second = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        if (invocation.prompt.includes("WS-02")) {
          await writeFile(join(root, "src", "example.ts"), "// ws-02\n", "utf8");
        }
        return pass();
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(second.result).toBe("COMPLETE");
    expect(second.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "complete",
      attempts: 1,
    });
    expect(verifyCalls).toBeGreaterThan(0);
  });

  it("stops the build as an environmental failure when the agent dies instantly with no changes", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });
    initGitRepo(root);
    let agentCalls = 0;
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return { exitCode: 1, output: "You've hit your session limit" };
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("FAILED");
    expect(report.reason).toContain("environment failure");
    expect(report.reason).toContain("session limit");
    // The recovery attempt is not burned on an environmental failure.
    expect(agentCalls).toBe(1);
    expect(verifyCalls).toBe(0);
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "failed",
      "WS-02": "not_started",
    });
  });

  it("fails the workstream when declared (NEW) files are missing after the attempt", async () => {
    const root = await fixture();
    await rm(join(root, "src", "example.ts"));
    const prompts: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompts.push(invocation.prompt);
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("FAILED");
    expect(report.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "failed",
      attempts: 2,
    });
    expect(prompts[1]).toContain("do not exist after the attempt");
    expect(prompts[1]).toContain("src/example.ts");
  });

  it("fails an attempt when the prompt cannot be delivered, even on exit 0", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });
    let attempt = 0;
    let verifyCalls = 0;
    const prompts: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        attempt += 1;
        prompts.push(invocation.prompt);
        return attempt === 1
          ? { exitCode: 0, output: "what would you like me to do?", inputError: "EPIPE" }
          : { exitCode: 0, output: "did the work" };
      },
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes[0]).toMatchObject({ id: "WS-01", attempts: 2 });
    expect(prompts[1]).toContain("could not be delivered");
    // Verification must not have run for the undelivered attempt.
    expect(verifyCalls).toBe(2);
  });

  it("fails a workstream when the agent exits nonzero even if verification would pass", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });
    let verifyCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 3, output: "agent crashed" }),
      verifyRunner: async () => {
        verifyCalls += 1;
        return pass();
      },
    });

    expect(report.result).toBe("FAILED");
    expect(verifyCalls).toBe(0);
    expect(report.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "failed",
      attempts: 2,
      agentExitCodes: [3, 3],
    });
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "failed",
      "WS-02": "not_started",
    });
  });

  it("rejects --start-from when a skipped dependency is not complete", async () => {
    const root = await fixture();
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      startFrom: "WS-02",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("WS-01");
    expect(agentCalls).toBe(0);
  });

  it("refuses a direct build when semantic convergence was never recorded", async () => {
    const root = await fixture();
    await rm(convergenceReceiptPath(root, "alpha"));
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("receipt is missing");
    expect(report.reason).toContain("--from build");
    expect(agentCalls).toBe(0);
  });

  it("refuses a direct build after a converged specification changes", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "tasks", "alpha", "ws-01.md"),
      `${spec("WS-01")}\nChanged after convergence.\n`,
      "utf8",
    );

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("receipt is stale");
  });

  it("marks a workstream failed and stops when recovery is exhausted", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: async () => ({ exitCode: 1, output: "still broken" }),
    });

    expect(report.result).toBe("FAILED");
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({
      id: "WS-01",
      status: "failed",
      attempts: 2,
      failedCommand: "npm test",
    });
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "failed",
      "WS-02": "not_started",
    });
    await expect(programStatus(root)).resolves.toBe("failed");
  });

  it("refuses to build until the acceptance criteria are approved", async () => {
    const root = await fixture({ requireCriteriaApproval: true });

    const blocked = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });
    expect(blocked.result).toBe("ABORTED");
    expect(blocked.reason).toContain("have not been approved");
    // The gate is a precondition, so nothing may have run.
    expect(blocked.outcomes).toEqual([]);

    await reviewCriteria({ cwd: root, programId: "alpha", approve: true });

    const allowed = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });
    expect(allowed.result).toBe("COMPLETE");
  });

  it("leaves builds alone when criteria approval is not required", async () => {
    const root = await fixture();
    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });
    expect(report.result).toBe("COMPLETE");
  });

  it("reports live progress lines for key events", async () => {
    const root = await fixture();
    const lines: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
      onProgress: (line) => lines.push(line),
    });

    expect(report.result).toBe("COMPLETE");
    expect(lines).toEqual([
      "per-workstream commits disabled: not a git repository",
      "no-op tree guard disabled: not a git repository",
      expect.stringContaining("build alpha: 2 workstream(s) to run, agent: fake-agent"),
      "WS-01 start: Core (1/2)",
      "WS-01 attempt 1/2: agent running",
      expect.stringContaining("WS-01 agent exited 0 after"),
      "WS-01 summary: (no summary block) ok",
      "WS-01 verify test: ok",
      expect.stringContaining("WS-01 complete after 1 attempt(s)"),
      "WS-02 start: API (2/2)",
      "WS-02 attempt 1/2: agent running",
      expect.stringContaining("WS-02 agent exited 0 after"),
      "WS-02 summary: (no summary block) ok",
      "WS-02 verify test: ok",
      expect.stringContaining("WS-02 complete after 1 attempt(s)"),
      expect.stringContaining("build alpha complete: 2 workstream(s)"),
    ]);
  });

  it("resumes by skipping workstreams already marked complete", async () => {
    const root = await fixture({ statuses: { "WS-01": "complete" } });
    const ran: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        ran.push(invocation.prompt.includes("WS-02") ? "WS-02" : "WS-01");
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    expect(ran).toEqual(["WS-02"]);
    expect(report.plan).toEqual([
      expect.objectContaining({ id: "WS-01", action: "skip" }),
      expect.objectContaining({ id: "WS-02", action: "run" }),
    ]);
    await expect(programStatus(root)).resolves.toBe("complete");
  });

  it("requires approval when the config demands it and runs nothing", async () => {
    const root = await fixture({ requireApproval: true });
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("APPROVAL_REQUIRED");
    expect(agentCalls).toBe(0);
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "not_started",
      "WS-02": "not_started",
    });
    await expect(programStatus(root)).resolves.toBe("planning");
  });

  it("returns the plan without executing on --dry-run", async () => {
    const root = await fixture({ requireApproval: true });

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      dryRun: true,
      agentRunner: pass,
      verifyRunner: pass,
    });

    expect(report.result).toBe("PLANNED");
    expect(report.plan.map(({ id }) => id)).toEqual(["WS-01", "WS-02"]);
    expect(report.agent).toBe("fake-agent --model sonnet");
    await expect(programStatus(root)).resolves.toBe("planning");
  });

  it("surfaces the resolved agent at the approval gate", async () => {
    const root = await fixture({ requireApproval: true });

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });

    expect(report.result).toBe("APPROVAL_REQUIRED");
    expect(report.agent).toBe("fake-agent --model sonnet");
  });

  it("aborts when no verify commands are configured", async () => {
    const root = await fixture({ verify: {} });

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("verify");
  });

  it("aborts on preflight validation blockers before running anything", async () => {
    const root = await fixture();
    await rm(join(root, "tasks", "alpha", "ws-02.md"));
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("spec-missing");
    expect(agentCalls).toBe(0);
  });

  it("rejects an ambiguous --start-from prefix", async () => {
    const root = await fixture();

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      startFrom: "WS-0",
      agentRunner: pass,
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("ambiguous");
  });

  it("runs from --start-from even when later workstreams are marked complete", async () => {
    const root = await fixture({
      statuses: { "WS-01": "complete", "WS-02": "complete" },
    });
    const ran: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      startFrom: "WS-02",
      agentRunner: async (invocation) => {
        ran.push(invocation.prompt.includes("WS-02") ? "WS-02" : "WS-01");
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    expect(ran).toEqual(["WS-02"]);
  });

  it("commits each workstream after it passes verification", async () => {
    const root = await fixture();
    initGitRepo(root);
    let workstream = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        workstream += 1;
        await writeFile(
          join(root, "src", "example.ts"),
          `// workstream ${workstream}\n`,
          "utf8",
        );
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    expect(gitLog(root)).toEqual([
      "build(alpha): WS-02 API",
      "build(alpha): WS-01 Core",
      "baseline",
    ]);
    for (const outcome of report.outcomes) {
      expect(outcome.commit).toMatch(/^[0-9a-f]{7,}$/u);
    }
    // Everything the workstreams produced is committed, including the
    // manifest status the runner wrote for them.
    expect(await dirtyEntries(root)).toEqual([]);
  });

  it("commits with the log dir gitignored, keeping logs out of the commit", async () => {
    const root = await fixture();
    initGitRepo(root);

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        await writeFile(
          join(root, "src", "example.ts"),
          invocation.prompt.includes("WS-02") ? "// ws-02\n" : "// ws-01\n",
          "utf8",
        );
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    for (const outcome of report.outcomes) {
      expect(outcome.commit).toMatch(/^[0-9a-f]{7,}$/u);
    }
    const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked.stdout).not.toContain("build-logs");
  });

  it("keeps the log dir out of the commit when it is not gitignored", async () => {
    const root = await fixture();
    await rm(join(root, ".gitignore"));
    initGitRepo(root);

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        await writeFile(
          join(root, "src", "example.ts"),
          invocation.prompt.includes("WS-02") ? "// ws-02\n" : "// ws-01\n",
          "utf8",
        );
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    expect(tracked.stdout).not.toContain("build-logs");
  });

  it("commits only up to the failing workstream", async () => {
    const root = await fixture({ maxRecoveryAttempts: 0 });
    initGitRepo(root);

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        await writeFile(
          join(root, "src", "example.ts"),
          invocation.prompt.includes("WS-02") ? "// ws-02\n" : "// ws-01\n",
          "utf8",
        );
        return pass();
      },
      // WS-02's implementation never verifies.
      verifyRunner: async () =>
        (await readFile(join(root, "src", "example.ts"), "utf8")).includes("ws-02")
          ? { exitCode: 1, output: "boom" }
          : pass(),
    });

    expect(report.result).toBe("FAILED");
    expect(gitLog(root)).toEqual(["build(alpha): WS-01 Core", "baseline"]);
    // WS-02's unverified work stays in the tree, uncommitted.
    expect(await dirtyEntries(root)).not.toEqual([]);
  });

  it("aborts before touching the manifest when the tree is dirty", async () => {
    const root = await fixture();
    initGitRepo(root);
    await writeFile(join(root, "src", "unrelated.ts"), "// mine\n", "utf8");
    let agentCalls = 0;

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        agentCalls += 1;
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("uncommitted change");
    expect(report.reason).toContain("src/unrelated.ts");
    expect(agentCalls).toBe(0);
    expect(await programStatus(root)).toBe("planning");
  });

  it("builds a dirty tree without committing when commits are disabled", async () => {
    const root = await fixture();
    initGitRepo(root);
    await writeFile(join(root, "src", "unrelated.ts"), "// mine\n", "utf8");

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      commit: false,
      agentRunner: async (invocation) => {
        await writeFile(
          join(root, "src", "example.ts"),
          `// ${invocation.prompt.includes("WS-02") ? "ws-02" : "ws-01"}\n`,
          "utf8",
        );
        return pass();
      },
      verifyRunner: pass,
    });

    expect(report.result).toBe("COMPLETE");
    expect(gitLog(root)).toEqual(["baseline"]);
    expect(report.outcomes.every(({ commit }) => commit === undefined)).toBe(true);
  });

  it("resumes on top of the uncommitted work its own failed run left behind", async () => {
    const root = await fixture({ maxRecoveryAttempts: 0 });
    initGitRepo(root);
    const implement = async (
      invocation: AgentInvocation,
    ): Promise<CommandResult> => {
      const id = invocation.prompt.includes("WS-02") ? "ws-02" : "ws-01";
      await writeFile(join(root, "src", `${id}.ts`), "// implemented\n", "utf8");
      return pass();
    };

    const first = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: implement,
      verifyRunner: async () => ({ exitCode: 1, output: "not yet" }),
    });
    expect(first.result).toBe("FAILED");
    expect(await dirtyEntries(root)).not.toEqual([]);

    // The same dirty tree the runner left is not a reason to refuse a re-run.
    const second = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: implement,
      verifyRunner: pass,
    });

    expect(second.result, second.reason).toBe("COMPLETE");
    expect(gitLog(root)[1]).toBe("build(alpha): WS-01 Core");
  });

  it("completes the workstream when git refuses the commit", async () => {
    const root = await fixture();
    initGitRepo(root);
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    const progressLines: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        await writeFile(
          join(root, "src", "example.ts"),
          `// ${invocation.prompt.includes("WS-02") ? "ws-02" : "ws-01"}\n`,
          "utf8",
        );
        return pass();
      },
      verifyRunner: pass,
      onProgress: (line) => progressLines.push(line),
    });

    expect(report.result).toBe("COMPLETE");
    expect(gitLog(root)).toEqual(["baseline"]);
    expect(progressLines.some((line) => line.includes("commit failed"))).toBe(true);
  });

  it("skips commits outside a git repository", async () => {
    const root = await fixture();
    const progressLines: string[] = [];

    const report = await buildProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: pass,
      verifyRunner: pass,
      onProgress: (line) => progressLines.push(line),
    });

    expect(report.result).toBe("COMPLETE");
    expect(
      progressLines.some((line) => line.includes("commits disabled")),
    ).toBe(true);
  });
});

describe("program memory attempt history", () => {
  it("briefs a resumed build with the previous run's failure diagnosis", async () => {
    const root = await fixture({ maxRecoveryAttempts: 0 });

    // Run 1: the agent exits cleanly but independent verification fails.
    // Historically its diagnosis lived in local variables and died here.
    const run1 = await buildProgram({
      cwd: root,
      programId: "alpha",
      yes: true,
      agentRunner: async () => ({ exitCode: 0, output: "agent done" }),
      verifyRunner: async () => ({
        exitCode: 1,
        output: "FAIL src/example.spec.ts — expected 2, received 3",
      }),
    });
    expect(run1.result).toBe("FAILED");

    const { readProgramMemory, lastFailedAttempt } = await import(
      "../src/program-memory.js"
    );
    const memory = await readProgramMemory(root, "alpha");
    const failed = lastFailedAttempt(memory, "build:WS-01");
    expect(failed?.outcome).toBe("failed");
    expect(failed?.reason).toContain("independent verification");
    expect(failed?.excerpt).toContain("expected 2, received 3");

    // Run 2: a fresh process. The first attempt must start from the recorded
    // failure, not the plain first-attempt prompt.
    const prompts: string[] = [];
    const run2 = await buildProgram({
      cwd: root,
      programId: "alpha",
      yes: true,
      agentRunner: async (invocation: AgentInvocation) => {
        prompts.push(invocation.prompt);
        return { exitCode: 0, output: "agent done" };
      },
      verifyRunner: pass,
    });
    expect(run2.result).toBe("COMPLETE");
    expect(prompts[0]).toContain("failed its previous build attempt");
    expect(prompts[0]).toContain("A previous build run failed this workstream");
    expect(prompts[0]).toContain("expected 2, received 3");
    // WS-02 never failed, so its prompt stays the plain first-attempt brief.
    expect(prompts[1]).not.toContain("failed its previous build attempt");

    const after = await readProgramMemory(root, "alpha");
    expect(lastFailedAttempt(after, "build:WS-01")).toBeUndefined();
    expect(after.attempts["build:WS-01"]?.at(-1)?.outcome).toBe("succeeded");
  });
});
