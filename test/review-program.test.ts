import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import type { Finding } from "../src/findings.js";
import { renderReviewReport, reviewProgram } from "../src/review-program.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function fixture(
  options: { validatorAgent?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-review-"));
  temporaryRoots.push(root);

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify({
      program: { id: "alpha", name: "Alpha", status: "planning" },
      successCriteria: [{ id: "SC-01", description: "Works." }],
      workstreams: [
        {
          id: "WS-01",
          name: "Core",
          taskFile: "tasks/alpha/ws-01.md",
          status: "not_started",
          dependencies: [],
        },
      ],
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n\nThe program document.\n",
    "utf8",
  );
  await writeFile(
    join(root, "tasks", "alpha", "ws-01.md"),
    "# WS-01: Core\n\n## Goal\nThe core module.\n",
    "utf8",
  );
  await writeFile(join(root, "AGENTS.md"), "# Agent Directives\n", "utf8");
  await writeFile(
    join(root, "pipeline.config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pipelineVersion: "0.1.0",
      visionPath: "docs/vision.md",
      requireApprovalBeforeBuild: false,
      agent: { command: "build-agent", args: [] },
      authorAgent: { command: "author-agent", args: [] },
      ...(options.validatorAgent === false
        ? {}
        : { validatorAgent: { command: "codex", args: ["exec"] } }),
      verify: { test: "npm test" },
    })}\n`,
    "utf8",
  );
  return root;
}

const replies = (findings: unknown[], summary = "Reviewed the program.") =>
  async (): Promise<CommandResult> => ({
    exitCode: 0,
    output: `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\`\n\n\`\`\`summary\n${summary}\n\`\`\`\n`,
  });

describe("reviewProgram", () => {
  it("aborts without a validatorAgent rather than reviewing with the author", async () => {
    const root = await fixture({ validatorAgent: false });
    const result = await reviewProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("validatorAgent");
    expect(result.reason).toContain("did not write these specs");
  });

  it("gives the reviewer the program document, manifest, and every spec", async () => {
    const root = await fixture();
    let prompt = "";
    await reviewProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation: AgentInvocation) => {
        prompt = invocation.prompt;
        return { exitCode: 0, output: '```json\n{"findings":[]}\n```' };
      },
    });

    expect(prompt).toContain("The program document.");
    expect(prompt).toContain("tasks/alpha/ws-01.md");
    expect(prompt).toContain("# WS-01: Core");
    expect(prompt).toContain("This is read-only");
  });

  it("parses findings and writes the report", async () => {
    const root = await fixture();
    const result = await reviewProgram({
      cwd: root,
      programId: "alpha",
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      agentRunner: replies([
        {
          severity: "major",
          category: "interface-contract",
          subject: "AuthToken",
          message: "WS-01 and WS-02 define AuthToken differently.",
          evidence: [
            { kind: "location", file: "tasks/alpha/ws-01.md", startLine: 12 },
          ],
          workstreamId: "WS-01",
        },
      ]),
    });

    expect(result.result).toBe("COMPLETE");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("major");
    expect(result.summary).toBe("Reviewed the program.");

    const report = await readFile(
      join(root, "docs", "programs", "alpha-review.md"),
      "utf8",
    );
    expect(report).toContain("# Program review: alpha");
    expect(report).toContain("AuthToken");
    expect(report).toContain("tasks/alpha/ws-01.md:12");
    expect(report).toContain("Reviewed the program.");
  });

  it("downgrades a finding that cites only a measurement", async () => {
    const root = await fixture();
    const result = await reviewProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: replies([
        {
          severity: "major",
          category: "scope-structure",
          subject: "WS-01 length",
          message: "WS-01 is 800 lines.",
          evidence: [{ kind: "measurement", metric: "lineCount", value: 800 }],
          workstreamId: "WS-01",
        },
      ]),
    });

    // The severity policy is the single choke point; a review cannot bypass it.
    expect(result.findings[0]?.severity).toBe("advisory");
  });

  it("aborts when the reviewer agent exits nonzero", async () => {
    const root = await fixture();
    const result = await reviewProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 3, output: "usage limit" }),
    });

    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("exited 3");
    expect(result.promptBytes).toBeGreaterThan(0);
  });

  it("aborts when the program has no manifest", async () => {
    const root = await fixture();
    const result = await reviewProgram({
      cwd: root,
      programId: "ghost",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });
    expect(result.result).toBe("ABORTED");
  });
});

describe("renderReviewReport", () => {
  const finding = (overrides: Partial<Finding> = {}): Finding => ({
    severity: "major",
    category: "coverage",
    subject: "SC-02",
    message: "No workstream covers SC-02.",
    evidence: [{ kind: "concern", named: "success criterion uncovered" }],
    ...overrides,
  });

  it("says so plainly when there is nothing to report", () => {
    const report = renderReviewReport("alpha", [], "All clear.", "codex", "now");
    expect(report).toContain("No findings.");
    expect(report).toContain("All clear.");
  });

  it("marks findings that no spec edit can fix", () => {
    const report = renderReviewReport(
      "alpha",
      [finding({ requiresReplan: true })],
      undefined,
      "codex",
      "now",
    );
    expect(report).toContain("Requires replanning");
  });

  it("orders findings by severity", () => {
    const report = renderReviewReport(
      "alpha",
      [
        finding({ severity: "minor", subject: "small" }),
        finding({ severity: "blocker", subject: "big" }),
      ],
      undefined,
      "codex",
      "now",
    );
    expect(report.indexOf("big")).toBeLessThan(report.indexOf("small"));
  });
});
