import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import { updateAsBuilt } from "../src/as-built.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function fixture(
  options: { existingSnapshot?: string; agent?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-as-built-"));
  temporaryRoots.push(root);

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await writeFile(
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n\nThe program document.\n",
    "utf8",
  );
  await writeFile(join(root, "AGENTS.md"), "# Agent Directives\n", "utf8");
  if (options.existingSnapshot !== undefined) {
    await writeFile(
      join(root, "docs", "as-built.md"),
      options.existingSnapshot,
      "utf8",
    );
  }
  await writeFile(
    join(root, "pipeline.config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pipelineVersion: "0.1.0",
      visionPath: "docs/vision.md",
      requireApprovalBeforeBuild: false,
      ...(options.agent === false
        ? {}
        : { agent: { command: "build-agent", args: [] } }),
      validatorAgent: { command: "codex", args: ["exec"] },
      verify: { test: "npm test" },
    })}\n`,
    "utf8",
  );
  return root;
}

/** A fake agent that writes the snapshot the runner then archives. */
function writesSnapshot(root: string, body = "# Project — As-Built\n") {
  return async (): Promise<CommandResult> => {
    await writeFile(join(root, "docs", "as-built.md"), body, "utf8");
    return {
      exitCode: 0,
      output: "```summary\nScanned 12 entry points.\n```",
    };
  };
}

describe("updateAsBuilt", () => {
  it("writes the snapshot and archives it under the program id", async () => {
    const root = await fixture();
    const result = await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSnapshot(root, "# Alpha — As-Built\n\n## Packages\n"),
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.summary).toBe("Scanned 12 entry points.");
    await expect(
      readFile(join(root, "docs", "as-built.md"), "utf8"),
    ).resolves.toContain("Alpha — As-Built");
    // The archive is the runner's copy, not the agent's — deterministic work
    // does not go to a model.
    await expect(
      readFile(join(root, "docs", "snapshots", "as-built-alpha.md"), "utf8"),
    ).resolves.toContain("Alpha — As-Built");
  });

  it("archives a byte-identical copy of the snapshot", async () => {
    const root = await fixture();
    await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSnapshot(root, "# Exact\n\nContent here.\n"),
    });

    const [snapshot, archive] = await Promise.all([
      readFile(join(root, "docs", "as-built.md"), "utf8"),
      readFile(join(root, "docs", "snapshots", "as-built-alpha.md"), "utf8"),
    ]);
    expect(archive).toBe(snapshot);
  });

  it("gives the agent the current snapshot so history is preserved", async () => {
    const root = await fixture({
      existingSnapshot: "# Old snapshot\n\n## Programs Completed\n- zero\n",
    });
    let prompt = "";
    await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation: AgentInvocation) => {
        prompt = invocation.prompt;
        await writeFile(join(root, "docs", "as-built.md"), "# New\n", "utf8");
        return { exitCode: 0, output: "" };
      },
    });

    expect(prompt).toContain("# Old snapshot");
    expect(prompt).toContain("Programs Completed");
    expect(prompt).toContain("The program document.");
  });

  it("tells the agent when there is no snapshot yet", async () => {
    const root = await fixture();
    let prompt = "";
    await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation: AgentInvocation) => {
        prompt = invocation.prompt;
        await writeFile(join(root, "docs", "as-built.md"), "# New\n", "utf8");
        return { exitCode: 0, output: "" };
      },
    });

    expect(prompt).toContain("this is the first snapshot");
  });

  it("aborts when the agent exits clean but writes nothing", async () => {
    const root = await fixture();
    const result = await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "all done!" }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("does not exist");
    expect(result.archivePath).toBeUndefined();
  });

  it("aborts when the agent exits nonzero", async () => {
    const root = await fixture();
    const result = await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 2, output: "credentials" }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("exited 2");
  });

  it("aborts when the prompt could not be delivered, even on exit 0", async () => {
    const root = await fixture();
    const result = await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({
        exitCode: 0,
        output: "",
        inputError: "EPIPE",
      }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("EPIPE");
  });

  it("aborts when no agent is configured", async () => {
    const root = await fixture({ agent: false });
    const result = await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("No agent configured");
  });
});

describe("program memory grounding", () => {
  it("feeds recorded waivers and diagnoses into the snapshot brief", async () => {
    const root = await fixture();
    const { appendMemoryEvents } = await import("../src/program-memory.js");
    const { identify } = await import("../src/findings.js");
    const finding = identify({
      severity: "major",
      category: "coverage",
      subject: "SC-02",
      message: "No workstream covers SC-02.",
      evidence: [{ kind: "concern", named: "uncovered criterion" }],
    });
    await appendMemoryEvents(root, "alpha", [
      {
        kind: "finding-raised",
        round: 1,
        finding,
        runId: "run-1",
        at: new Date().toISOString(),
      },
      {
        kind: "human-decision",
        id: finding.id,
        decision: "waived",
        rationale: "ships in phase 2",
        runId: "decide-1",
        at: new Date().toISOString(),
      },
      {
        kind: "stage-diagnosis",
        stage: "author",
        outcome: "requires-replan",
        reason: "dependency cycle",
        detail: "WS-01 -> WS-02 -> WS-01",
        runId: "author-1",
        at: new Date().toISOString(),
      },
    ]);

    let prompt = "";
    await updateAsBuilt({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompt = invocation.prompt;
        await writeFile(join(root, "docs", "as-built.md"), "# As-built\n", "utf8");
        return { exitCode: 0, output: "done" };
      },
    });
    expect(prompt).toContain("Program memory (recorded pipeline conclusions)");
    expect(prompt).toContain("SC-02");
    expect(prompt).toContain("ships in phase 2");
    expect(prompt).toContain("dependency cycle");
  });
});
