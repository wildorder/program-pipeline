import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { summaryContract } from "./agent-summary.js";
import {
  FINDING_CATEGORIES,
  type Finding,
  type IdentifiedFinding,
} from "./findings.js";

/**
 * The runner composes the validator brief; no caller may append to it.
 *
 * This is the same separation the build runner already applies to commits.
 * When an orchestrating agent hand-assembled the prompt for the external
 * validator, it could — and did — fold in its own framing ("ignore length",
 * "don't worry about file counts"), which narrowed the critique before it
 * began and produced passes that looked more thorough than they were. The
 * brief is now built from the program's own files plus a fixed criteria
 * block, so an independent validator receives the same instructions every
 * time and nothing can quietly gag it.
 */

/** Severity is assigned by the critic, then re-decided by the policy layer. */
const CRITERIA = `
## How to judge

Classify each finding as blocker, major, or minor.

**Blocker** — the program cannot be built as specified: a spec referenced by
the manifest is missing, a success criterion has no workstream, a workstream
has no traceability, a dependency names a workstream that does not exist, the
dependency graph has a cycle, or a Files Touched entry lacks its (NEW) or
(MODIFY) annotation.

**Major** — the build will probably go wrong: two workstreams define the same
type or interface differently, a workstream consumes another's output without
declaring the dependency, acceptance criteria cannot be objectively checked,
or the tests as described would not catch a wrong implementation.

**Minor** — real but survivable: ambiguous wording, unclear sequencing, prose
duplicated from the program document, or local implementation detail that
does not threaten a green checkpoint.

## Independently green checkpoints

Judge every workstream from the state that actually exists when it starts: a
green repository containing its declared dependencies, but none of the later
workstreams. Applying that workstream alone must leave every configured build,
typecheck, test, and lint command green. A later workstream may extend the
result; it may never be required to repair broken consumers, temporary type
errors, or failing tests introduced by this one.

For shared interfaces and cross-cutting migrations, inspect the sequence as
well as the final design. Safe plans use expand -> migrate -> contract/delete:
add a compatible surface, migrate bounded consumer groups while both surfaces
coexist, then remove the legacy surface only after the removal workstream
depends on every consumer migration. A clean-break final product does not
permit a broken intermediate checkpoint.

An unsafe checkpoint, a workstream that must be decomposed to stay green, or
destructive migration ordering is a **blocker** with \`requiresReplan: true\`.
It cannot be repaired by adding prose to the existing spec.

## Evidence is required

Every finding must cite a cause. A cause is either a **location** (file plus
line range) or a **named concern** (the specific contradiction, the specific
bundled responsibilities). A finding supported only by a **measurement** — a
line count, a file count — is an observation about a symptom, and the
severity policy will set it aside as advisory.

This is not a restriction on what you may raise. Say a spec is too long, and
say it as forcefully as the evidence warrants — but say *why* it is too long.
"WS-04 is 800 lines" gets set aside. "WS-04 bundles authentication and
telemetry; split at implementation step 12" and "lines 210-340 restate the
program document verbatim" are actionable and keep full severity. Length and
file count are symptoms. Name the disease.

Do not recommend truncating a spec, deleting inlined interfaces, or dropping
implementation steps, tests, or acceptance criteria in order to make a spec
shorter. Detail that a build agent needs is not bloat.

## Judge the tests, not just their shape

A Tests section can name a scenario, an expected behavior, and an assertion
target and still describe worthless tests. Give a direct opinion on whether
these are good tests:

1. Would a plausible **wrong** implementation pass them? Tests that assert a
   mock was called, or that a function returns something truthy, do not
   discriminate.
2. Is every acceptance criterion backed by at least one test that could
   actually fail? An acceptance criterion no test can falsify is not verified.
3. Are failure and edge paths covered, or only the happy path? If the spec
   names error handling, boundary values, or concurrency, the tests must
   reach them.
4. Do the tests bind to the module's public behavior rather than to internals
   that will churn on the next refactor?

Weak tests are a **major** finding with category test-quality. Say plainly
which numbered cases are weak and what would make them discriminating.

## When the fix is not in tasks/

Some problems cannot be repaired by editing a spec — a workstream that must
be split in two, a missing workstream, a dependency ordering that the manifest
itself gets wrong. Mark those findings with "requiresReplan": true. Do not
propose a spec edit that papers over them. Work of that kind goes back to
program planning, and further rounds of spec polish on a workstream that
should not exist in that shape are wasted.
`.trim();

function outputContract(expectedWorkstreamIds: string[]): string {
  return `
## Output

Reply with one fenced \`\`\`json block and nothing that matters outside it:

\`\`\`json
{
  "checkpointAssessments": [
    {
      "workstreamId": "WS-01",
      "status": "safe" | "unsafe",
      "reason": "why this workstream alone does or does not leave the repository green"
    }
  ],
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "category": ${FINDING_CATEGORIES.map((c) => `"${c}"`).join(" | ")},
      "subject": "short noun phrase naming what this is about, e.g. SC-03, AuthToken interface, Tests case 4",
      "message": "one or two sentences stating the defect",
      "evidence": [
        { "kind": "location", "file": "tasks/x/ws-01.md", "startLine": 42, "endLine": 60 },
        { "kind": "concern", "named": "auth and telemetry in one workstream", "detail": "optional" },
        { "kind": "measurement", "metric": "lineCount" | "fileCount", "value": 800 }
      ],
      "workstreamId": "WS-01",
      "requiresReplan": false
    }
  ]
}
\`\`\`

Keep "subject" stable for the same underlying issue across rounds — it is how
a re-raised finding is recognized as the same one, so do not reword it to
describe the same problem differently. Return an empty findings array if you
find nothing.

Return exactly one checkpoint assessment for every workstream in this round:
${expectedWorkstreamIds.join(", ") || "(none)"}. An unsafe assessment is a
structural failure even if the findings array accidentally omits it. Do not
mark a checkpoint safe merely because the final program state is coherent;
judge the repository immediately after that workstream alone.
`.trim();
}

export interface BriefSources {
  programId: string;
  programDoc: string;
  manifest: string;
  specs: Array<{ path: string; content: string }>;
  agentsMd?: string;
  vision?: string;
  contextDocs: Array<{ path: string; content: string }>;
}

export async function loadBriefSources(
  root: string,
  programId: string,
  specPaths: string[],
  options: { visionPath?: string; contextDocs?: string[] } = {},
): Promise<BriefSources> {
  const readOptional = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(resolve(root, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const specs: Array<{ path: string; content: string }> = [];
  for (const path of specPaths) {
    const content = await readOptional(path);
    if (content !== undefined) specs.push({ path, content });
  }
  const contextDocs: Array<{ path: string; content: string }> = [];
  for (const path of options.contextDocs ?? []) {
    const content = await readOptional(path);
    if (content !== undefined) contextDocs.push({ path, content });
  }
  const programDoc =
    (await readOptional(join("docs", "programs", `${programId}-program.md`))) ??
    "(program document not found)";
  const manifest =
    (await readOptional(
      join("docs", "programs", `${programId}-manifest.json`),
    )) ?? "(manifest not found)";
  const agentsMd = await readOptional("AGENTS.md");
  const vision = options.visionPath
    ? await readOptional(options.visionPath)
    : undefined;
  return {
    programId,
    programDoc,
    manifest,
    specs,
    ...(agentsMd === undefined ? {} : { agentsMd }),
    ...(vision === undefined ? {} : { vision }),
    contextDocs,
  };
}

function documentBlock(label: string, content: string): string {
  return `### ${label}\n\n\`\`\`\n${content}\n\`\`\`\n`;
}

function sourceSection(sources: BriefSources): string {
  const parts = [
    documentBlock("Program document", sources.programDoc),
    documentBlock("Manifest", sources.manifest),
  ];
  if (sources.vision) parts.push(documentBlock("Vision", sources.vision));
  if (sources.agentsMd) parts.push(documentBlock("AGENTS.md", sources.agentsMd));
  for (const doc of sources.contextDocs) {
    parts.push(documentBlock(`Context: ${doc.path}`, doc.content));
  }
  for (const spec of sources.specs) {
    parts.push(documentBlock(`Spec: ${spec.path}`, spec.content));
  }
  return parts.join("\n");
}

export interface RoundContext {
  round: number;
  totalRounds: number;
  scoped: boolean;
  /** Every workstream whose checkpoint safety must be assessed this round. */
  expectedWorkstreamIds: string[];
  /** Findings the writer declined last round, with the reason given. */
  openDisagreements: Array<{ finding: Finding; reason: string }>;
  /** Everything already raised, so the critic does not simply repeat it. */
  alreadyRaised: Finding[];
}

function priorRoundSection(context: RoundContext): string {
  if (context.round === 1) return "";
  const lines: string[] = ["## What earlier rounds already covered\n"];
  if (context.alreadyRaised.length > 0) {
    lines.push(
      "These findings were already raised. Re-raise one only if it is genuinely unfixed — use the same subject when you do, and do not reword it:",
      "",
    );
    for (const finding of context.alreadyRaised) {
      const scope = finding.workstreamId ? `${finding.workstreamId} ` : "";
      lines.push(`- [${finding.severity}] ${scope}${finding.subject}`);
    }
    lines.push("");
  }
  if (context.openDisagreements.length > 0) {
    lines.push(
      "The writer declined these and gave a reason. Judge the reason on its merits. If you still believe the finding stands, re-raise it with the same subject and say why the reason does not hold; it will be recorded as an open disagreement for a human to settle rather than decided by whoever edits last:",
      "",
    );
    for (const { finding, reason } of context.openDisagreements) {
      lines.push(`- ${finding.subject} — declined: ${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function composeCriticBrief(
  sources: BriefSources,
  context: RoundContext,
): string {
  const scopeNote = context.scoped
    ? "This round is scoped to the workstreams that changed since the last round; earlier rounds covered the whole program."
    : "This round covers the whole program.";
  return [
    `# Validate the workstream specs for program ${sources.programId}`,
    "",
    `You are the critic for round ${context.round} of ${context.totalRounds}. ${scopeNote}`,
    "",
    "Read every document below and report defects. **Do not edit any file.** Your job this round is to find problems, not to fix them — a separate writer will apply the fixes. Reporting a defect you could have fixed yourself is the correct behavior.",
    "",
    CRITERIA,
    "",
    priorRoundSection(context),
    "## Material",
    "",
    sourceSection(sources),
    "",
    outputContract(context.expectedWorkstreamIds),
    "",
    summaryContract(),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function composeWriterBrief(
  sources: BriefSources,
  findings: IdentifiedFinding[],
  context: RoundContext,
): string {
  const list = findings
    .map((finding, index) => {
      const scope = finding.workstreamId ? `${finding.workstreamId} ` : "";
      const evidence = finding.evidence
        .map((item) =>
          item.kind === "location"
            ? `${item.file}:${item.startLine}${item.endLine ? `-${item.endLine}` : ""}`
            : item.kind === "concern"
              ? `${item.named}${item.detail ? ` (${item.detail})` : ""}`
              : `${item.metric}=${item.value}`,
        )
        .join("; ");
      return `${index + 1}. [id ${finding.id}] [${finding.severity}] ${scope}${finding.subject} — ${finding.message}\n   evidence: ${evidence}`;
    })
    .join("\n");

  return [
    `# Apply validation fixes for program ${sources.programId}`,
    "",
    `You are the writer for round ${context.round} of ${context.totalRounds}. A critic reviewed the workstream specs and reported the findings below.`,
    "",
    "Fix what is genuinely wrong by editing the spec files under `tasks/`. Make precise, minimal edits.",
    "",
    "Rules:",
    "",
    "- Do not shorten a spec to reduce its length, and do not delete inlined interfaces, implementation steps, tests, or acceptance criteria. Detail a build agent needs is not bloat.",
    "- Do not split a workstream and do not edit the manifest. If a finding truly requires that, decline it and say so — it goes back to program planning.",
    "- You may decline any finding you believe is wrong. Declining is a legitimate outcome and it will be recorded, not overridden. Give a real reason.",
    "- Do not commit.",
    "",
    "## Findings",
    "",
    list,
    "",
    "## Material",
    "",
    sourceSection(sources),
    "",
    "## Output",
    "",
    "After making your edits, reply with one fenced ```json block:",
    "",
    "```json",
    '{ "applied": ["<id>"], "rejected": [ { "id": "<id>", "reason": "why this finding does not hold" } ] }',
    "```",
    "",
    "Every finding id must appear in exactly one of the two lists.",
    "",
    summaryContract(),
  ].join("\n");
}
