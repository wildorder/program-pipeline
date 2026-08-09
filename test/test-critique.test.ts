import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import { critiqueTests } from "../src/test-critique.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function repoWithChanges(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-critique-"));
  temporaryRoots.push(root);
  const git = (...args: string[]): void => {
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  };
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(root, "core.ts"), "export const a = 1;\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "base");
  // An uncommitted change is exactly what the runner reviews before it commits.
  await writeFile(
    join(root, "core.test.ts"),
    "it('works', () => { expect(mock).toHaveBeenCalled(); });\n",
    "utf8",
  );
  git("add", "-A");
  return root;
}

const validator = { command: "critic-cli", args: [], promptMode: "stdin" as const };

const weakTestReply = `\`\`\`json
{
  "findings": [
    {
      "severity": "major",
      "category": "test-quality",
      "subject": "core happy path test",
      "message": "Asserts only that a mock was called; a wrong implementation would pass.",
      "evidence": [{ "kind": "concern", "named": "asserts only that the mock was called" }]
    }
  ]
}
\`\`\``;

describe("build-time test critique", () => {
  it("skips with a reason when no validator agent is configured", async () => {
    const root = await repoWithChanges();
    const result = await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "## Tests\n1. It works.",
      validator: undefined,
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("no validatorAgent is configured");
  });

  it("reports weak tests as a finding", async () => {
    const root = await repoWithChanges();
    const result = await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "## Tests\n1. It works.",
      validator,
      agentRunner: async () => ({ exitCode: 0, output: weakTestReply }),
    });
    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("major");
    expect(result.findings[0]?.workstreamId).toBe("WS-01");
  });

  it("sends the diff and the spec to the validator", async () => {
    const root = await repoWithChanges();
    let received: AgentInvocation | undefined;
    await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "## Tests\n1. Distinctive spec marker.",
      validator,
      agentRunner: async (invocation): Promise<CommandResult> => {
        received = invocation;
        return { exitCode: 0, output: '```json\n{"findings":[]}\n```' };
      },
    });
    expect(received?.prompt).toContain("Distinctive spec marker");
    expect(received?.prompt).toContain("core.test.ts");
    expect(received?.prompt).toContain("toHaveBeenCalled");
  });

  it("asks whether tests were weakened to make the suite pass", async () => {
    const root = await repoWithChanges();
    let received: AgentInvocation | undefined;
    await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "spec",
      validator,
      agentRunner: async (invocation): Promise<CommandResult> => {
        received = invocation;
        return { exitCode: 0, output: '```json\n{"findings":[]}\n```' };
      },
    });
    expect(received?.prompt).toContain("weakened, skipped, or deleted");
    expect(received?.prompt).toContain("Do not edit any file");
  });

  it("skips rather than failing when the validator agent errors", async () => {
    const root = await repoWithChanges();
    const result = await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "spec",
      validator,
      agentRunner: async () => ({ exitCode: 1, output: "session limit" }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipped).toContain("exited 1");
    expect(result.findings).toEqual([]);
  });

  it("skips when the workstream produced no diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-critique-"));
    temporaryRoots.push(root);
    spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    const result = await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "spec",
      validator,
      agentRunner: async () => ({ exitCode: 0, output: weakTestReply }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipped).toBe("no diff to review");
  });

  it("downgrades a critique finding that names no cause", async () => {
    const root = await repoWithChanges();
    const result = await critiqueTests({
      root,
      workstreamId: "WS-01",
      workstreamName: "Core",
      spec: "spec",
      validator,
      agentRunner: async () => ({
        exitCode: 0,
        output: `\`\`\`json
{"findings":[{"severity":"major","category":"test-quality","subject":"test count","message":"Only 3 tests.","evidence":[{"kind":"measurement","metric":"lineCount","value":3}]}]}
\`\`\``,
      }),
    });
    expect(result.findings[0]?.severity).toBe("advisory");
  });
});
