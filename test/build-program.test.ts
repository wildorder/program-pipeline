import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProgram,
  sanitizedEnvironment,
  type AgentInvocation,
  type CommandResult,
} from "../src/build-program.js";

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
  statuses?: Record<string, string>;
  maxRecoveryAttempts?: number;
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
        validatorAgent: { command: "codex", args: ["exec", "--model", "gpt-sol"] },
        models: { author: "claude-code/opus", validator: "gpt-sol" },
        verify: options.verify ?? { test: "npm test" },
        ...(options.maxRecoveryAttempts === undefined
          ? {}
          : { build: { maxRecoveryAttempts: options.maxRecoveryAttempts } }),
      },
      null,
      2,
    )}\n`,
    "utf8",
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

const pass = async (): Promise<CommandResult> => ({ exitCode: 0, output: "ok" });

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
    expect(verifyCalls).toEqual(["npm test", "npm test"]);
    await expect(manifestStatuses(root)).resolves.toEqual({
      "WS-01": "complete",
      "WS-02": "complete",
    });

    expect(report.eventsPath).toBeDefined();
    const events = (await readFile(report.eventsPath as string, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map(({ event }) => event)).toEqual([
      "build-start",
      "tree-guard-disabled",
      "workstream-start",
      "agent-start",
      "agent-exit",
      "verify-start",
      "verify-result",
      "workstream-complete",
      "workstream-start",
      "agent-start",
      "agent-exit",
      "verify-start",
      "verify-result",
      "workstream-complete",
      "build-complete",
    ]);
  });

  it("does not trust the agent exit code and recovers once on verification failure", async () => {
    const root = await fixture({ maxRecoveryAttempts: 1 });
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

  it("fails an attempt when the agent changes nothing in a git repository", async () => {
    const root = await fixture();
    const git = (args: string[]): void => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git(["init"]);
    git(["add", "-A"]);
    git(["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "baseline"]);

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
      "no-op tree guard disabled: not a git repository",
      expect.stringContaining("build alpha: 2 workstream(s) to run, agent: fake-agent"),
      "WS-01 start: Core (1/2)",
      "WS-01 attempt 1/2: agent running",
      expect.stringContaining("WS-01 agent exited 0 after"),
      "WS-01 verify test: ok",
      expect.stringContaining("WS-01 complete after 1 attempt(s)"),
      "WS-02 start: API (2/2)",
      "WS-02 attempt 1/2: agent running",
      expect.stringContaining("WS-02 agent exited 0 after"),
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
});
