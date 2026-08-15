import { runProcess, type AgentRunner } from "./agent-runner.js";
import { resolveSummary, summaryContract } from "./agent-summary.js";
import { sortBySeverity, type Finding } from "./findings.js";
import type { AgentConfig } from "./pipeline-config.js";
import { applySeverityPolicy } from "./severity-policy.js";

/**
 * Build-time critique of the tests a workstream agent wrote.
 *
 * The runner's whole notion of correctness is "every verify command exited
 * zero" — but the agent that wrote the implementation also wrote the tests
 * that check it, so a green suite proves the two agree, not that either is
 * right. This pass hands the diff to the *validator* agent, which had no part
 * in writing either, and asks whether the tests would actually catch a wrong
 * implementation.
 *
 * It annotates; it does not block. A model judgment is not a reliable enough
 * signal to stall an unattended build that has already passed independent
 * verification, and blocking would need a rewrite-and-recheck loop with its
 * own risk of never settling. The findings go to the events log and the final
 * report, where a human can act on them.
 */

const CRITIQUE_BRIEF = `
You are reviewing the tests in a diff. You did not write this code.

The implementation and its tests were written by the same agent, so a passing
suite only shows they agree with each other. Judge whether the tests would
catch a wrong implementation.

Answer these directly:

1. Would a plausible **wrong** implementation pass these tests? Assertions
   that a mock was called, that a value is truthy, or that no error was thrown
   do not discriminate.
2. Is every acceptance criterion in the spec backed by at least one test that
   could actually fail?
3. Are failure and edge paths tested, or only the happy path?
4. Do the tests bind to public behavior, or to internals that will churn on
   the next refactor?
5. Were any tests weakened, skipped, or deleted to make the suite pass?

Question 5 matters most. Say so plainly if you see it.

Report only what you can support from the diff. Reply with one fenced json
block:

\`\`\`json
{
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "category": "test-quality",
      "subject": "short noun phrase, e.g. AuthToken expiry test",
      "message": "what is wrong and what would make it discriminating",
      "evidence": [
        { "kind": "location", "file": "src/x.test.ts", "startLine": 12 },
        { "kind": "concern", "named": "asserts only that the mock was called" }
      ]
    }
  ]
}
\`\`\`

Return an empty findings array if the tests are sound. Do not edit any file.
`.trim();

export interface TestCritiqueResult {
  ran: boolean;
  /** Why the critique did not run, when it did not. */
  skipped?: string;
  findings: Finding[];
  /** The validator's own account of the review, verbatim. */
  summary?: string;
}

export interface TestCritiqueOptions {
  root: string;
  workstreamId: string;
  workstreamName: string;
  spec: string;
  validator: AgentConfig | undefined;
  agentRunner: AgentRunner;
  /** Bounds a huge diff; the tail is the least useful part of a patch. */
  maxDiffChars?: number;
}

async function workstreamDiff(root: string): Promise<string> {
  // Everything since the last commit: the runner commits per workstream, so
  // this is exactly what this workstream's agent produced.
  const result = await runProcess("git", ["diff", "HEAD"], {
    cwd: root,
    shell: false,
  });
  if (result.exitCode !== 0) return "";
  return result.output;
}

export async function critiqueTests(
  options: TestCritiqueOptions,
): Promise<TestCritiqueResult> {
  if (!options.validator) {
    return {
      ran: false,
      skipped:
        "build.critiqueTests is on but no validatorAgent is configured; the agent that wrote the tests cannot review them.",
      findings: [],
    };
  }

  const diff = await workstreamDiff(options.root);
  if (diff.trim() === "") {
    return { ran: false, skipped: "no diff to review", findings: [] };
  }

  const limit = options.maxDiffChars ?? 200_000;
  const truncated = diff.length > limit;
  const body = truncated ? diff.slice(0, limit) : diff;

  const prompt = [
    `# Review the tests for ${options.workstreamId}: ${options.workstreamName}`,
    "",
    CRITIQUE_BRIEF,
    "",
    "## Workstream spec",
    "",
    "```",
    options.spec,
    "```",
    "",
    `## Diff${truncated ? " (truncated)" : ""}`,
    "",
    "```diff",
    body,
    "```",
    "",
    summaryContract(),
  ].join("\n");

  const result = await options.agentRunner({
    command: options.validator.command,
    args: options.validator.args,
    prompt,
    promptMode: options.validator.promptMode,
    cwd: options.root,
  });

  if (result.exitCode !== 0) {
    return {
      ran: false,
      skipped: `validator agent exited ${result.exitCode}`,
      findings: [],
    };
  }

  // Imported lazily to keep the parser in one place.
  const { parseCriticFindings } = await import("./validate-loop.js");
  const findings = applySeverityPolicy(
    parseCriticFindings(result.output).map((finding) => ({
      ...finding,
      category: "test-quality" as const,
      workstreamId: options.workstreamId,
    })),
  );
  return {
    ran: true,
    findings: sortBySeverity(findings),
    summary: resolveSummary(result.output).text,
  };
}
