import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import { fingerprint, type Finding } from "../src/findings.js";
import {
  extractJson,
  hasArrayKey,
  parseCriticFindings,
  parseCriticReply,
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

## Checkpoint Safety
The change is additive, so existing consumers and verification remain green.

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Validation exits successfully.
`;

describe("extractJson block selection", () => {
  const answer = {
    checkpointAssessments: [
      { workstreamId: "WS-01", status: "safe", reason: "additive change" },
    ],
    findings: [
      {
        severity: "blocker",
        category: "coverage",
        subject: "SC-02",
        message: "No workstream covers SC-02.",
        evidence: [{ kind: "concern", named: "uncovered criterion" }],
      },
    ],
    classAnalyses: [{
      subject: "SC-02",
      scope: "isolated",
      rootCause: "criterion has no owner",
      affectedSubjects: ["SC-02"],
      checkedSubjects: ["SC-02"],
      completenessBasis: "manifest success criteria and workstream traceability",
    }],
  };

  /** A critic citing a manifest fragment as evidence, after its answer. */
  const withTrailingJson = [
    "I found a problem.",
    "```json",
    JSON.stringify(answer),
    "```",
    "For reference, WS-04 declares:",
    "```json",
    '{ "id": "WS-04", "dependencies": ["WS-01"] }',
    "```",
  ].join("\n");

  it("takes the last parseable block when no shape is requested", () => {
    expect(extractJson(withTrailingJson)).toEqual({
      id: "WS-04",
      dependencies: ["WS-01"],
    });
  });

  it("skips blocks that do not match the requested shape", () => {
    expect(
      extractJson(withTrailingJson, (value) => hasArrayKey(value, "findings")),
    ).toEqual(answer);
  });

  it("keeps the critic's findings when another json block follows them", () => {
    // The regression: this returned zero findings, the loop read that as a
    // clean round, and a blocker was reported as PASSED.
    const reply = parseCriticReply(withTrailingJson);
    expect(reply.found).toBe(true);
    expect(reply.findings).toHaveLength(1);
    expect(reply.findings[0]?.severity).toBe("blocker");
    expect(reply.checkpointAssessments).toHaveLength(1);
  });

  it("distinguishes an unreadable reply from a genuinely clean one", () => {
    expect(parseCriticReply('```json\n{"findings":[]}\n```')).toEqual({
      found: true,
      findings: [],
      checkpointAssessments: [],
      missingAssessments: [],
      requirementsChangeRequested: false,
      criteriaPatches: [],
      classAnalyses: [],
      missingClassAnalyses: [],
    });
    expect(parseCriticReply("Looks good to me!").found).toBe(false);
    expect(parseCriticReply('```json\n{"notes":[]}\n```').found).toBe(false);
  });

  it("diagnoses missing, malformed, and contract-mismatched JSON", () => {
    expect(parseCriticReply("Looks good to me!").protocolFailure).toMatchObject({
      kind: "missing-json",
    });
    expect(
      parseCriticReply('```json\n{"findings":[}\n```').protocolFailure,
    ).toMatchObject({ kind: "invalid-json" });
    expect(
      parseCriticReply('```json\n{"notes":[]}\n```').protocolFailure,
    ).toMatchObject({ kind: "contract-mismatch" });
  });

  it("accepts uppercase JSON fences and CRLF output", () => {
    const reply = parseCriticReply(
      `\`\`\`JSON\r\n${JSON.stringify(answer)}\r\n\`\`\``,
    );
    expect(reply.found).toBe(true);
    expect(reply.findings).toHaveLength(1);
  });

  it("finds the final contract in a CLI transcript with nested fences and unmatched prose quotes", () => {
    const transcript = [
      'exec transcript: model said "then inspected the prompt',
      "```",
      "### embedded spec",
      "```ts",
      'const legacy = { directionId: "warm" };',
      'const interrupted = { "neverClosed": true;',
      "```",
      "tokens used 74,187",
      "```json",
      JSON.stringify(answer, null, 2),
      "```",
      "```summary",
      "Found one blocker.",
      "```",
    ].join("\n");

    const reply = parseCriticReply(transcript, ["WS-01"]);
    expect(reply.found).toBe(true);
    expect(reply.protocolFailure).toBeUndefined();
    expect(reply.checkpointAssessments).toHaveLength(1);
    expect(reply.findings).toHaveLength(1);
  });

  it("prefers the last matching block when the critic revises itself", () => {
    const reply = [
      "```json",
      '{"findings":[]}',
      "```",
      "Actually, on reflection:",
      "```json",
      JSON.stringify(answer),
      "```",
    ].join("\n");
    expect(parseCriticReply(reply).findings).toHaveLength(1);
  });

  it("shape-matches the writer verdict too", () => {
    const reply = [
      "```json",
      '{"applied":["abc"],"rejected":[]}',
      "```",
      "```json",
      '{"unrelated":true}',
      "```",
    ].join("\n");
    const verdict = parseWriterVerdict(reply);
    expect(verdict.found).toBe(true);
    expect(verdict.applied).toEqual(["abc"]);
    expect(parseWriterVerdict("I made the edits.").found).toBe(false);
  });
});

async function project(
  overrides: {
    validate?: Record<string, unknown>;
    authorAgent?: Record<string, unknown> | null;
  } = {},
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
      agent: { command: "build-cli", args: ["-p", "--model", "cheap"] },
      ...(overrides.authorAgent === null
        ? {}
        : {
            authorAgent: overrides.authorAgent ?? {
              command: "author-cli",
              args: ["-p"],
            },
          }),
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

function criticReply(
  findings: Array<Partial<Finding>>,
  checkpointAssessments: Array<Record<string, unknown>> = [
    {
      workstreamId: "WS-01",
      status: "safe",
      reason: "the change is additive and leaves existing consumers intact",
    },
  ],
): string {
  const completed = findings.map((finding) => ({
    severity: "major",
    category: "test-quality",
    subject: "Tests case 1",
    message: "Assertion does not discriminate.",
    evidence: [{ kind: "concern", named: "tautological assertion" }],
    workstreamId: "WS-01",
    ...finding,
  }));
  return `Here is my review.\n\n\`\`\`json\n${JSON.stringify({
    checkpointAssessments,
    findings: completed,
    classAnalyses: completed.map(({ subject }) => ({
      subject,
      scope: "isolated",
      rootCause: "the named test does not discriminate",
      affectedSubjects: [subject],
      checkedSubjects: [subject],
      completenessBasis: "the numbered test case named by the finding",
    })),
  })}\n\`\`\`\n`;
}

function writerReply(applied: string[], rejected: Array<[string, string]> = []): string {
  return `Done.\n\n\`\`\`json\n${JSON.stringify({
    applied,
    rejected: rejected.map(([id, reason]) => ({ id, reason })),
    resolutionProofs: applied.map((id) => ({
      id,
      changedPaths: ["tasks/alpha/ws-01.md"],
      checkedSubjects: ["the complete numbered test case"],
      completenessBasis: "the finding identifies one isolated test case",
    })),
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

  it("reports every expected workstream whose checkpoint assessment is missing", () => {
    const reply = parseCriticReply(
      '```json\n{"checkpointAssessments":[],"findings":[]}\n```',
      ["WS-01", "WS-02"],
    );
    expect(reply.found).toBe(true);
    expect(reply.missingAssessments).toEqual(["WS-01", "WS-02"]);
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
    expectedWorkstreamIds: ["WS-01"],
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

  it("requires a green checkpoint assessment for every workstream", () => {
    const brief = composeCriticBrief(sources, context);
    expect(brief).toContain("expand -> migrate -> contract/delete");
    expect(brief).toContain("none of the later");
    expect(brief).toContain("exactly one checkpoint assessment");
    expect(brief).toContain("WS-01");
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
        const output = replies[index] ?? criticReply([]);
        index += 1;
        return { exitCode: 0, output };
      },
    };
  }

  const BLOCKER_REPLY = [
    "```json",
    JSON.stringify({
      checkpointAssessments: [
        {
          workstreamId: "WS-01",
          status: "safe",
          reason: "the checkpoint preserves the green repository",
        },
      ],
      findings: [
        {
          severity: "blocker",
          category: "coverage",
          subject: "SC-02",
          message: "No workstream covers SC-02.",
          evidence: [{ kind: "concern", named: "uncovered criterion" }],
        },
      ],
      classAnalyses: [{
        subject: "SC-02",
        scope: "isolated",
        rootCause: "criterion has no owner",
        affectedSubjects: ["SC-02"],
        checkedSubjects: ["SC-02"],
        completenessBasis: "manifest criterion list",
      }],
    }),
    "```",
  ].join("\n");

  it("fails rather than passing when the critic's reply cannot be parsed", async () => {
    const root = await project();
    const unreadable = "I reviewed everything and it looks fine.";
    const { runner, calls } = recorder([unreadable, unreadable]);

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });

    // The gate must never pass on a critique that never arrived. Reporting
    // this as "no findings" is what turned an unreadable reply into PASSED.
    expect(result.outcome).toBe("aborted");
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("missing-json");
    expect(result.reason).toContain("after one contract-correction retry");
    expect(calls).toHaveLength(2);
    expect(result.criticLogs).toHaveLength(2);
    await expect(readFile(result.criticLogs[0]!, "utf8")).resolves.toBe(
      unreadable,
    );
  });

  it("repairs one malformed critic response without repeating the review", async () => {
    const root = await project();
    const malformed =
      '```json\n{"checkpointAssessments":[],"findings":[}\n```\n```summary\nFound one issue.\n```';
    const { runner, calls } = recorder([malformed, criticReply([])]);
    const lines: string[] = [];

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
      onProgress: (line) => lines.push(line),
    });

    expect(result.outcome).toBe("converged");
    expect(result.result).toBe("PASSED");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("Correct your previous validation response");
    expect(calls[1]?.prompt).toContain(malformed);
    expect(calls[1]?.prompt).toContain("Do not review the program again");
    expect(lines.some((line) => line.includes("retrying once"))).toBe(true);
    expect(result.criticLogs).toHaveLength(2);
  });

  it("fails rather than passing when a workstream assessment is missing", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      '```json\n{"checkpointAssessments":[],"findings":[]}\n```',
      '```json\n{"checkpointAssessments":[],"findings":[]}\n```',
    ]);

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("missing-assessments");
    expect(result.reason).toContain("WS-01");
    expect(calls).toHaveLength(2);
  });

  it("fails closed when a blocker or major has no class-wide analysis", async () => {
    const root = await project();
    const incomplete = `\`\`\`json\n${JSON.stringify({
      checkpointAssessments: [{ workstreamId: "WS-01", status: "safe", reason: "green" }],
      findings: [{ severity: "major", category: "acceptance-criteria", subject: "SC-01", message: "one command conflicts", evidence: [{ kind: "concern", named: "signature mismatch" }] }],
      classAnalyses: [],
    })}\n\`\`\``;
    const { runner, calls } = recorder([incomplete, incomplete]);
    const result = await validateLoop({ cwd: root, programId: "alpha", agentRunner: runner });
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toContain("missing-class-analysis");
    expect(result.reason).toContain("SC-01");
    expect(calls).toHaveLength(2);
  });

  it("turns an unsafe checkpoint assessment into an immediate replan", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      criticReply([], [
        {
          workstreamId: "WS-01",
          status: "unsafe",
          reason: "removes the shared type before consumers migrate",
        },
      ]),
    ]);

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });

    expect(result.outcome).toBe("requires-replan");
    expect(result.result).toBe("FAILED");
    expect(result.replanFindings[0]).toMatchObject({
      severity: "blocker",
      category: "scope-structure",
      workstreamId: "WS-01",
      requiresReplan: true,
    });
    expect(result.replanReport).toBe(
      join(root, "docs", "programs", "alpha-replan.json"),
    );
    const report = JSON.parse(
      await readFile(result.replanReport!, "utf8"),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: 2,
      programId: "alpha",
      outcome: "requires-replan",
      checkpointAssessments: [
        {
          workstreamId: "WS-01",
          status: "unsafe",
          reason: "removes the shared type before consumers migrate",
        },
      ],
    });
    expect(report.replanFindings).toEqual(result.replanFindings);
    expect(report.relatedFindings).toEqual(result.findings);
    expect(report.planningInstruction).toContain("/plan-program alpha");
    expect(calls).toHaveLength(1);
  });

  it("fails when the writer's verdict cannot be parsed", async () => {
    const root = await project();
    const { runner } = recorder([BLOCKER_REPLY, "I made the edits."]);

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("no verdict block");
  });

  it("fails when the writer claims a fix without a closure proof", async () => {
    const root = await project();
    const findingId = idOf({});
    const { runner } = recorder([
      criticReply([{}]),
      `\`\`\`json\n${JSON.stringify({ applied: [findingId], rejected: [], resolutionProofs: [] })}\n\`\`\``,
    ]);
    const result = await validateLoop({ cwd: root, programId: "alpha", agentRunner: runner });
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toContain("without class-wide resolution proof");
  });

  it("still reads the findings when the critic quotes json after them", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      `${BLOCKER_REPLY}\n\nFor reference, WS-04 declares:\n\n\`\`\`json\n{ "id": "WS-04", "dependencies": ["WS-01"] }\n\`\`\``,
      '```json\n{"applied":[],"rejected":[]}\n```',
    ]);

    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 1,
      agentRunner: runner,
    });

    // The finding survived the trailing block, so the round counted as having
    // found something: a writer ran instead of the loop declaring it clean.
    // (The PASSED/FAILED verdict itself comes from the deterministic
    // validator over the final tree, not from a model finding.)
    expect(result.findings.some(({ subject }) => subject === "SC-02")).toBe(
      true,
    );
    expect(calls).toHaveLength(2);
    expect(result.outcome).not.toBe("aborted");
  });

  it("converges when the first round finds nothing new", async () => {
    const root = await project();
    const staleReport = join(
      root,
      "docs",
      "programs",
      "alpha-replan.json",
    );
    await writeFile(staleReport, '{"stale":true}\n', "utf8");
    const { runner, calls } = recorder([criticReply([])]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });
    expect(result.outcome).toBe("converged");
    expect(result.result).toBe("PASSED");
    expect(calls).toHaveLength(1);
    await expect(readFile(staleReport, "utf8")).rejects.toThrow();
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
    expect(result.result).toBe("FAILED");
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
    // The identity is stable, but an unchanged blocker/major is unresolved —
    // it cannot be mistaken for a clean convergence round.
    expect(result.outcome).toBe("cap-reached");
    expect(result.result).toBe("FAILED");
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

  it("runs the spec loop on authorAgent, never the cheap build agent", async () => {
    const root = await project();
    const { runner, calls } = recorder([
      criticReply([{}]),
      writerReply([idOf({})]),
    ]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      rounds: 1,
      agentRunner: runner,
    });
    expect(calls.map(({ command }) => command)).not.toContain("build-cli");
    expect(result.agents?.author).toBe("author-cli -p");
    expect(result.agents?.borrowedBuildAgent).toBe(false);
  });

  it("warns loudly when it has to borrow the build agent for spec critique", async () => {
    const root = await project({ authorAgent: null });
    const lines: string[] = [];
    const { runner } = recorder([criticReply([])]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
      onProgress: (line) => lines.push(line),
    });
    expect(result.agents?.borrowedBuildAgent).toBe(true);
    expect(result.agents?.author).toBe("build-cli -p --model cheap");
    expect(lines.join("\n")).toContain("WARNING: no authorAgent configured");
  });

  it("names both resolved agents before spending anything", async () => {
    const root = await project();
    const lines: string[] = [];
    const { runner } = recorder([criticReply([])]);
    await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
      onProgress: (line) => lines.push(line),
    });
    expect(lines[0]).toBe("agents: author author-cli -p, validator critic-cli exec");
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
    const { runner } = recorder([criticReply([])]);
    const result = await validateLoop({
      cwd: root,
      programId: "alpha",
      agentRunner: runner,
    });
    expect(result.outcome).toBe("converged");
    expect(result.result).toBe("FAILED");
  });
});
