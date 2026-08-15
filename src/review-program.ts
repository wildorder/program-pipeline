import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveValidatorAgent,
  tail,
  type AgentRunner,
} from "./agent-runner.js";
import {
  resolveSummary,
  summaryContract,
  summaryLine,
} from "./agent-summary.js";
import { sortBySeverity, type Finding } from "./findings.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";
import { applySeverityPolicy } from "./severity-policy.js";
import { parseCriticFindings } from "./validate-loop.js";
import { loadBriefSources } from "./validator-brief.js";

/**
 * Read-only architecture and integration review of a planned program.
 *
 * Deliberately the `validatorAgent`: this reviews specs the author agent
 * wrote, and a reviewer that is the same model as the author reviews its own
 * taste. Same reasoning as the convergence loop's critic and the build's test
 * critique.
 *
 * It reports and never edits. Mechanical spec checks belong to `validate`,
 * and spec repair belongs to `converge`; what is left for a review is the
 * class of problem that only shows up when you hold the whole program at
 * once — two workstreams defining the same type differently, a package no
 * workstream touches, an execution order that cannot work.
 */

const REVIEW_BRIEF = `
You are reviewing a planned program before any of it is implemented. You did
not write these specs.

**This is read-only. Do not edit any file.** Report what you find; someone
else decides what to change.

Deterministic spec validation has already run, so do not re-report mechanical
defects — missing sections, absent traceability IDs, unannotated file lists.
Your job is the class of problem that only appears when the whole program is
held at once.

Answer every dimension below, citing workstream IDs, file paths, and line
ranges.

## Coverage gaps

- Which program features or requirements have no workstream coverage?
- Which success criteria have no mapped workstream?
- Which manifest packages are untouched by every workstream?

## Contradictions between workstreams

- Do two workstreams define the same type, function, or interface differently?
- Do they conflict on data model, API shape, or behavior?
- Does an "Existing Interfaces to Consume" section disagree with the spec of
  the workstream that actually produces it?

## Missing dependencies

- Does a workstream consume types, functions, files, or packages from another
  without declaring that dependency?
- Does the manifest graph match the dependencies the specs actually imply?
- Is the resulting execution order safe?

## Over-engineering and sizing

- Does any workstream exceed the program's scope?
- Are there abstractions, strategies, or extension points that no success
  criterion supports?
- Flag workstreams touching more than roughly eight core files, or combining
  unrelated concerns.

Spec length is not a defect. Treat it as a prompt to look closer and then say
what is actually wrong: concrete interfaces, implementation steps, tests, and
acceptance criteria must never be penalized for necessary detail.

## Integration risk

- Which workstreams carry the most cross-package dependencies?
- Where can package-boundary types, behavior contracts, or shared state drift?
- Which assumptions are left unspecified?
- Which workstreams modify the same files?
`.trim();

const OUTPUT_CONTRACT = `
## Output

Reply with one fenced \`\`\`json block:

\`\`\`json
{
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "category": "coverage" | "interface-contract" | "dependency" | "scope-structure" | "redundancy" | "traceability" | "manifest" | "spec-format" | "test-quality" | "acceptance-criteria",
      "subject": "short noun phrase naming what this is about",
      "message": "one or two sentences stating the problem and what to do",
      "evidence": [
        { "kind": "location", "file": "tasks/x/ws-01.md", "startLine": 42 },
        { "kind": "concern", "named": "AuthToken defined twice, differently" }
      ],
      "workstreamId": "WS-01",
      "requiresReplan": false
    }
  ]
}
\`\`\`

Every finding must cite a cause: a **location** (file and line) or a **named
concern**. A finding supported only by a measurement — a line count, a file
count — is an observation about a symptom, and the severity policy sets it
aside as advisory. Name the disease, not the symptom.

Mark \`requiresReplan\` on anything no spec edit can fix: a workstream that
must be split, a workstream that is missing, an ordering the manifest itself
gets wrong.

Return an empty findings array if the program is sound.
`.trim();

export interface ReviewProgramOptions {
  cwd: string;
  programId: string;
  agentRunner?: AgentRunner;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

export interface ReviewProgramResult {
  programId: string;
  result: "COMPLETE" | "ABORTED";
  reason?: string;
  /** The resolved reviewing agent, when configured. */
  agent?: string;
  findings: Finding[];
  /** The reviewer's own account of the review, verbatim. */
  summary?: string;
  reportPath?: string;
  promptBytes?: number;
}

export function reportPathFor(root: string, programId: string): string {
  return join(root, "docs", "programs", `${programId}-review.md`);
}

export function renderReviewReport(
  programId: string,
  findings: Finding[],
  summary: string | undefined,
  reviewer: string,
  timestamp: string,
): string {
  const lines = [
    `# Program review: ${programId}`,
    "",
    `Reviewed by \`${reviewer}\` on ${timestamp}. Read-only: nothing here has been applied.`,
    "",
  ];

  if (summary) lines.push("## Reviewer's summary", "", summary, "");

  if (findings.length === 0) {
    lines.push("## Findings", "", "No findings.", "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push("## Findings", "");
  for (const finding of sortBySeverity(findings)) {
    const scope = finding.workstreamId ? ` ${finding.workstreamId}` : "";
    lines.push(
      `### [${finding.severity}]${scope} ${finding.subject}`,
      "",
      finding.message,
      "",
    );
    if (finding.requiresReplan) {
      lines.push(
        "> Requires replanning: no spec edit fixes this.",
        "",
      );
    }
    for (const evidence of finding.evidence) {
      if (evidence.kind === "location") {
        const range = evidence.endLine ? `-${evidence.endLine}` : "";
        lines.push(`- \`${evidence.file}:${evidence.startLine}${range}\``);
      } else if (evidence.kind === "concern") {
        lines.push(
          `- ${evidence.named}${evidence.detail ? ` — ${evidence.detail}` : ""}`,
        );
      } else {
        lines.push(`- ${evidence.metric} = ${evidence.value} (advisory)`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function reviewProgram(
  options: ReviewProgramOptions,
): Promise<ReviewProgramResult> {
  const root = resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const runAgent = options.agentRunner ?? defaultAgentRunner;
  const progress = options.onProgress ?? ((): void => {});

  const aborted = (reason: string): ReviewProgramResult => ({
    programId: options.programId,
    result: "ABORTED",
    reason,
    findings: [],
  });

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }

  // Never falls back to the author or build agent: a reviewer that is the
  // same model as the author is reviewing its own taste.
  const reviewer = resolveValidatorAgent(config);
  if (!reviewer) {
    return aborted(
      "No `validatorAgent` configured in pipeline.config.json; a program review wants a model that did not write these specs.",
    );
  }
  const agentLabel = describeAgent(reviewer);
  progress(`agents: reviewer ${agentLabel}`);

  const manifestPath = join(
    root,
    "docs",
    "programs",
    `${options.programId}-manifest.json`,
  );
  let specPaths: string[];
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      workstreams?: Array<{ taskFile: string }>;
    };
    specPaths = (raw.workstreams ?? []).map(({ taskFile }) => taskFile);
  } catch (error) {
    return aborted(
      `Could not read ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const sources = await loadBriefSources(root, options.programId, specPaths, {
    ...(config.visionPath ? { visionPath: config.visionPath } : {}),
    contextDocs: config.contextDocs,
  });

  const prompt = [
    `# Review the program ${options.programId}`,
    "",
    REVIEW_BRIEF,
    "",
    "## Material",
    "",
    `### Program document\n\n\`\`\`\n${sources.programDoc}\n\`\`\`\n`,
    `### Manifest\n\n\`\`\`\n${sources.manifest}\n\`\`\`\n`,
    ...(sources.vision ? [`### Vision\n\n\`\`\`\n${sources.vision}\n\`\`\`\n`] : []),
    ...(sources.agentsMd
      ? [`### AGENTS.md\n\n\`\`\`\n${sources.agentsMd}\n\`\`\`\n`]
      : []),
    ...sources.contextDocs.map(
      (doc) => `### Context: ${doc.path}\n\n\`\`\`\n${doc.content}\n\`\`\`\n`,
    ),
    ...sources.specs.map(
      (spec) => `### Spec: ${spec.path}\n\n\`\`\`\n${spec.content}\n\`\`\`\n`,
    ),
    "",
    OUTPUT_CONTRACT,
    "",
    summaryContract(),
  ].join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  progress(`reviewing ${specPaths.length} spec(s)`);
  const result = await runAgent({
    command: reviewer.command,
    args: reviewer.args,
    prompt,
    promptMode: reviewer.promptMode,
    cwd: root,
  });

  if (result.exitCode !== 0) {
    return {
      ...aborted(
        `Reviewer agent (${agentLabel}) exited ${result.exitCode}: ${tail(result.output, 800)}`,
      ),
      agent: agentLabel,
      promptBytes,
    };
  }

  const summary = resolveSummary(result.output);
  const findings = sortBySeverity(
    applySeverityPolicy(parseCriticFindings(result.output)),
  );
  progress(`reviewer says: ${summaryLine(summary)}`);
  progress(`${findings.length} finding(s)`);

  const reportPath = reportPathFor(root, options.programId);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderReviewReport(
      options.programId,
      findings,
      summary.text,
      agentLabel,
      now().toISOString(),
    ),
    "utf8",
  );
  progress(`review written to ${reportPath}`);

  return {
    programId: options.programId,
    result: "COMPLETE",
    agent: agentLabel,
    findings,
    summary: summary.text,
    reportPath,
    promptBytes,
  };
}
