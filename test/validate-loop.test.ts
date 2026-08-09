import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import { fingerprint, type Finding } from "../src/findings.js";
import {
  extractJson,
  parseCriticFindings,
  parseWriterVerdict,
  validateLoop,
} from "../src/validate-loop.js";
import { composeCriticBrief, composeWriterBrief } from "../src/validator-brief.js";

const temporaryRoots: string[] = [];

const SPEC = `# WS-01: Core

## Traceability
- SC-01

## Dependencies
None.

## Files Touched
- \`src/core.ts\` (NEW)

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Validation exits successfully.
`;

async function project(
  overrides: { validate?: Record<string, unknown> } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-loop-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  await writeFile(
    join(root, "pipeline.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      pipelineVersion: "0.7.0",
      visionPath: "docs/vision.md",
      requireApprovalBeforeBuild: false,
      agent: { command: "author-cli", args: ["-p"] },
      validatorAgent: { command: "critic-cli", args: ["exec"] },
      ...(overrides.validate ? { validate: overrides.validate } : {}),
    }),
    "utf8",
  );
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    JSON.stringify({
      program: { id: "alpha", name: "Alpha", status: "planning" },
      successCriteria: [{ id: "SC-01", description: "Feature works." }],
      workstreams: [
        {
          id: "WS-01",
          name: "Core",
          taskFile: "tasks/alpha/ws-01-core.md",
          status: "not_started",
          dependencies: [],
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n\n## Success Criteria\n- SC-01 Feature works.\n",
    "utf8",
  );
  await writeFile(join(root, "tasks", "alpha", "ws-01-core.md"), SPEC, "utf8");
  return root;
}

function criticReply(findings: Array<Partial<Finding>>): string {
  return `Here is my review.\n\n\`\`\`json\n${JSON.stringify({
    findings: findings.map((finding) => ({
      severity: "major",
      category: "test-quality",
      subject: "Tests case 1",
      message: "Assertion does not discriminate.",
      evidence: [{ kind: "concern", named: "tautological assertion" }],
      workstreamId: "WS-01",
      ...finding,
    })),
  })}\n\`\`\`\n`;
}

function writerReply(applied: string[], rejected: Array<[string, string]> = []): string {
  return `Done.\n\n\`\`\`json\n${JSON.stringify({
    applied,
    rejected: rejected.map(([id, reason]) => ({ id, reason })),
  })}\n\`\`\``;
}

function idOf(overrides: Partial<Finding>): string {
  return fingerprint({
    severity: "major",
    category: "test-quality",
    subject: "Tests case 1",
    message: "",
    evidence: [],
    workstreamId: "WS-01",
    ...overrides,
  });
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("reply parsing", () => {
  it("takes the last fenced json block when the model narrates around it", () => {
    const parsed = extractJson(
      'Thinking...\n```json\n{"a":1}\n```\nActually:\n```json\n{"a":2}\n```\n',
    );
    expect(parsed).toEqual({ a: 2 });
  });

  it("falls back to a bare brace span when the model omits fences", () => {
    expect(extractJson('prelude {"findings": []} trailer')).toEqual({
      findings: [],
    });
  });

  it("returns undefined rather than throwing on unparseable output", () => {
    expect(extractJson("no json at all")).toBeUndefined();
  });

  it("discards findings with an unknown category or severity", () => {
    const findings = parseCriticFindings(
      criticReply([{ category: "not-a-category" as never }, { severity: "fatal" as never }]),
    );
    expect(findings).toHaveLength(0);
  });

  it("discards findings with no subject, since identity depends on it", () => {
    expect(parseCriticFindings(criticReply([{ subject: "  " }]))).toHaveLength(0);
  });

  it("keeps a well-formed finding and its replan flag", () => {
    const [finding] = parseCriticFindings(
      criticReply([{ requiresReplan: true }]),
    );
    expect(finding?.subject).toBe("Tests case 1");
    expect(finding?.requiresReplan).toBe(true);
  });

  it("defaults a missing rejection reason rather than dropping the rejection", () => {
    const verdict = parseWriterVerdict(
      '```json\n{"applied":[],"rejected":[{"id":"abc"}]}\n```',
    );
    expect(verdict.rejected).toEqual([{ id: "abc", reason: "no reason given" }]);
  });
});

describe("brief composition", () => {
  const sources = {
    programId: "alpha",
    programDoc: "# Alpha",
    manifest: "{}",
    specs: [{ path: "tasks/alpha/ws-01-core.md", content: SPEC }],
    contextDocs: [],
  };
  const context = {
    round: 1,
    totalRounds: 2,
    scoped: false,
    openDisagreements: [],
    alreadyRaised: [],
  };

  it("tells the critic not to edit, so critique and authorship stay separate", () => {
    const brief = composeCriticBrief(sources, context);
    expect(brief).toContain("Do not edit any file");
  });

  it("asks for a direct opinion on test quality, not just test shape", () => {
    const brief = composeCriticBrief(sources, context);
    expect(brief).toContain("Would a plausible **wrong** implementation pass");
    expect(brief).toContain("Weak tests are a **major** finding");
  });

  it("invites length criticism that names a cause instead of forbidding it", () => {
    const brief = composeCriticBrief(sources, context);
    expect(brief).toContain("say it as forcefully as the evidence warrants");
    expect(brief).toContain("Name the disease.");
  });

  it("still refuses truncation as a remedy", () => {
    expect(composeCriticBrief(sources, context)).toContain(
      "Do not recommend truncating a spec",
    );
  });

  it("surfaces open disagreements to the critic from round two on", () => {
    const finding = {
      id: "abc",
      severity: "major" as const,
      category: "test-quality" as const,
      subject: "Tests case 1",
      message: "weak",
      evidence: [],
    };
    const brief = composeCriticBrief(sources, {
      ...context,
      round: 2,
      openDisagreements: [{ finding, reason: "covered by an integration test" }],
      alreadyRaised: [finding],
    });
    expect(brief).toContain("covered by an integration test");
    expect(brief).toContain("open disagreement for a human to settle");
  });

  it("tells the writer that declining is legitimate", () => {
    const brief = composeWriterBrief(
      sources,
      [
        {
          id: "abc",
          severity: "major",
          category: "test-quality",
          subject: "Tests case 1",
          message: "weak",
          evidence: [{ kind: "concern", named: "tautological assertion" }],
        },
      ],
      context,
    );
    expect(brief).toContain("Declining is a legitimate outcome");
    expect(brief).toContain("[id abc]");
    expect(brief).toContain("Do not commit");
  });
});

describe("convergence loop", () => {
  function recorder(replies: string[]): {
    runner: (invocation: AgentInvocation) => Promise<CommandResult>;
    calls: AgentInvocation[];
  } {
    const calls: AgentInvocation[] = [];
    let index = 0;
    return {
      calls,
      runner: async (invocation: AgentInvocation) => {
        calls.push(invocation);
        const output = replies[index] ?? '```json\n{"findings":[]}\n```';
        index += 1;
        return { exitCode: 0, output };
      },
    };
  }

  it("converges when the first round finds nothing new", async () => {
    const root = await project();
    const { runner, calls } = recorder(['```json\n{"findings":[]}\n```']);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });
    expect(result.outcome).toBe("converged");
    expect(result.result).toBe("PASSED");
    expect(calls).toHaveLength(1);
  });

  it("swaps critic and writer between rounds so neither grades its own work", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      criticReply([{}]),
      writerReply([idOf({})]),
      criticReply([{ subject: "Tests case 2" }]),
      writerReply([idOf({ subject: "Tests case 2" })]),
    ]);
    await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 2,
      agentRunner: runner,
    });
    expect(calls[0]?.command).toBe("critic-cli");
    expect(calls[1]?.command).toBe("author-cli");
    expect(calls[2]?.command).toBe("author-cli");
    expect(calls[3]?.command).toBe("critic-cli");
  });

  it("stops immediately on a replan finding instead of polishing further", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      criticReply([
        {
          category: "scope-structure",
          subject: "WS-01 scope",
          requiresReplan: true,
        },
      ]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 3,
      agentRunner: runner,
    });
    expect(result.outcome).toBe("requires-replan");
    expect(result.result).toBe("FAILED");
    expect(result.replanFindings).toHaveLength(1);
    // Critic only — no writer was asked to paper over a structural defect.
    expect(calls).toHaveLength(1);
  });

  it("reports cap-reached when findings keep arriving", async () => {
    const root = await project();
    const { runner } = recorder([
      criticReply([{ subject: "Tests case 1" }]),
      writerReply([idOf({ subject: "Tests case 1" })]),
      criticReply([{ subject: "Tests case 2" }]),
      writerReply([idOf({ subject: "Tests case 2" })]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 2,
      agentRunner: runner,
    });
    expect(result.outcome).toBe("cap-reached");
    expect(result.rounds).toHaveLength(2);
  });

  it("treats a reworded re-raise as the same finding, not a new one", async () => {
    const root = await project();
    const { runner } = recorder([
      criticReply([{ message: "Assertion is tautological." }]),
      writerReply([idOf({})]),
      criticReply([{ message: "This case would pass a wrong implementation." }]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 3,
      agentRunner: runner,
    });
    // Round 2's critique is the same finding in different words, so the loop
    // recognizes a round with nothing new and converges instead of looping.
    expect(result.outcome).toBe("converged");
    expect(result.rounds).toHaveLength(2);
  });

  it("records a declined-then-re-raised finding as an open disagreement", async () => {
    const root = await project();
    const { runner } = recorder([
      criticReply([{}]),
      writerReply([], [[idOf({}), "covered by an existing integration test"]]),
      criticReply([{ subject: "Tests case 9" }]),
      writerReply([idOf({ subject: "Tests case 9" })]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 2,
      agentRunner: runner,
    });
    expect(result.openDisagreements).toHaveLength(1);
    expect(result.openDisagreements[0]?.reason).toBe(
      "covered by an existing integration test",
    );
  });

  it("clears a disagreement once a later round applies the fix", async () => {
    const root = await project();
    const { runner } = recorder([
      criticReply([{}]),
      writerReply([], [[idOf({}), "disputed"]]),
      criticReply([{ subject: "Tests case 3" }]),
      writerReply([idOf({}), idOf({ subject: "Tests case 3" })]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 2,
      agentRunner: runner,
    });
    expect(result.openDisagreements).toHaveLength(0);
  });

  it("never scopes down during the first two rounds", async () => {
    const root = await project({ validate: { rounds: 3 } });
    const { runner } = recorder([
      criticReply([{ subject: "Tests case 1" }]),
      writerReply([idOf({ subject: "Tests case 1" })]),
      criticReply([{ subject: "Tests case 2" }]),
      writerReply([idOf({ subject: "Tests case 2" })]),
      criticReply([{ subject: "Tests case 3" }]),
      writerReply([idOf({ subject: "Tests case 3" })]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });
    expect(result.rounds[0]?.scoped).toBe(false);
    expect(result.rounds[1]?.scoped).toBe(false);
  });

  it("caps rounds at the hard maximum even when asked for more", async () => {
    const root = await project();
    const { runner } = recorder([]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 99,
      agentRunner: runner,
    });
    expect(result.rounds.length).toBeLessThanOrEqual(3);
  });

  it("aborts rather than running critic and writer as the same model", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-loop-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "pipeline.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        pipelineVersion: "0.7.0",
        visionPath: "docs/vision.md",
        requireApprovalBeforeBuild: false,
        agent: { command: "author-cli" },
      }),
      "utf8",
    );
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toContain("validatorAgent");
  });

  it("aborts when the critic agent fails instead of reporting a pass", async () => {
    const root = await project();
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 1, output: "session limit reached" }),
    });
    expect(result.outcome).toBe("aborted");
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("session limit reached");
  });

  it("fails the gate on a surviving mechanical blocker even after converging", async () => {
    const root = await project();
    // Remove the spec the manifest points at: a blocker the loop cannot talk
    // its way out of, since the gate is decided by the deterministic pass.
    await rm(join(root, "tasks", "alpha", "ws-01-core.md"));
    const { runner } = recorder(['```json\n{"findings":[]}\n```']);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });
    expect(result.outcome).toBe("converged");
    expect(result.result).toBe("FAILED");
  });
});
