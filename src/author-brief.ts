import { summaryContract } from "./agent-summary.js";
import { SPEC_CONTRACT } from "./validate.js";

/**
 * The runner composes the authoring brief; no caller may append to it.
 *
 * Same reasoning as the validator brief. When an orchestrating agent
 * assembled this prompt it authored the spec inside its own context — already
 * carrying the whole planning conversation — composed its own instructions,
 * and then ran the validation gate over its own output. Three seams, all
 * closed by having the package build the brief and spawn a clean agent.
 */

export interface WorkstreamScope {
  summary: string;
  includes: string[];
  excludes: string[];
}

/** One line of the program roster: what exists, not how it works. */
export interface RosterEntry {
  id: string;
  name: string;
  scope: WorkstreamScope;
}

export interface AuthorTarget {
  id: string;
  name: string;
  taskFile: string;
  dependencies: string[];
  scope: WorkstreamScope;
}

export interface AuthorBriefSources {
  programId: string;
  target: AuthorTarget;
  /** Every workstream in the program, this one included. */
  roster: RosterEntry[];
  /** Full specs of the direct dependencies that fit the brief budget. */
  dependencySpecs: Array<{ id: string; path: string; content: string }>;
  /** Direct dependencies cut to their roster entry to fit the budget. */
  demoted: string[];
  programDoc: string;
  manifest: string;
  agentsMd?: string;
  vision?: string;
  contextDocs: Array<{ path: string; content: string }>;
}

const SPEC_TEMPLATE = `
# {WS-ID}: {Name}

## Goal
[What this workstream delivers and why.]

## Traceability
[Program success criteria satisfied, using stable IDs such as \`SC-01\`.]

## Dependencies
[Workstream IDs from this program that must finish first.]

## Context Files (Agent MUST read before implementing)
[Exact paths. Always include:
- \`AGENTS.md\`
- Relevant sections of the vision document
- Specific source files consumed or modified
Do not include other workstream specs or program documents.]

## Package
[Target package or directory.]

## Files Touched
[One list item per touched file: \`- \\\`path/to/file.ts\\\` (NEW)\`,
\`(MODIFY — optional short note)\`, or \`(DELETE)\`. Only list items are validated as file
entries; keep context about untouched files in prose, not bullets.]

## Existing Interfaces to Consume
[Name the canonical source path and symbol for each existing interface this
workstream consumes. Inline only the exact new or changed contract needed to
implement this workstream; do not copy large unchanged source excerpts.]

## Checkpoint Safety
[Explain why the repository is green after this workstream alone, starting
from a green tree containing only its declared dependencies. State how old
and new surfaces coexist while later workstreams remain unbuilt. A later
workstream must never be needed to restore build, typecheck, tests, or lint.]

## Implementation Steps
[Precise, intentionally ordered, numbered steps.]

## Tests
[Numbered cases, each naming the scenario, expected behavior, and assertions.]

## Acceptance Criteria
[Numbered, objectively verifiable completion conditions.]
`.trim();

const AUTHORING_RULES = `
## How to write the spec

The section names, ID formats, and file annotations are the contract enforced
by \`program-pipeline validate\`. The validator is canonical: do not rename
the required sections (\`${SPEC_CONTRACT.sections.traceability}\`,
\`${SPEC_CONTRACT.sections.checkpointSafety}\`,
\`${SPEC_CONTRACT.sections.filesTouched}\`, \`${SPEC_CONTRACT.sections.tests}\`,
\`${SPEC_CONTRACT.sections.acceptanceCriteria}\`) and do not change the
\`SC-xx\` / \`WS-xx\` / \`(NEW)\` / \`(MODIFY)\` / \`(DELETE)\` formats.

- Make the spec self-contained. An implementation agent reading it, AGENTS.md,
  and its Context Files must have everything it needs.
- Name canonical paths and symbols for existing interfaces. Inline only the
  exact new or changed contract an implementation agent needs; do not copy
  large unchanged source excerpts.
- Mark every file \`(NEW)\`, \`(MODIFY)\`, or \`(DELETE)\`.
- Order implementation steps intentionally.
- Include at least one program success-criterion ID in Traceability.

### Test quality

Naming a scenario, an expected behavior, and an assertion target satisfies the
mechanical contract and still permits worthless tests. Validation judges
whether the tests are *good*, so write them that way:

1. **Discriminate.** A plausible wrong implementation must fail. A test that
   asserts a mock was called, or that a result is truthy, proves nothing.
   State the concrete expected value, not its shape.
2. **Cover every acceptance criterion.** Each numbered criterion needs at
   least one test that could actually fail.
3. **Reach the failure paths.** If the spec names error handling, boundary
   values, empty inputs, or concurrency, test them.
4. **Bind to public behavior**, not to internals the next refactor will churn.

### Scope and length

There is no line-count cap, and detail an implementation agent needs is not
bloat. Never drop interfaces, steps, tests, or acceptance criteria to make a
spec shorter.

### Independently green checkpoints

Every workstream is committed and verified before the next one starts. Write
the spec so that, beginning with a green repository containing only its
declared dependencies, this workstream alone leaves the repository green
under every configured build, typecheck, test, and lint command. It may not
leave broken consumers, temporary type errors, or tests for a later
workstream to repair.

For a shared interface migration, use an expand -> migrate -> contract/delete
sequence: add a compatible surface first, migrate bounded consumer groups in
independently green workstreams, and remove the legacy surface only after a
final workstream depends on every consumer migration. A clean-break product
requirement describes the final state; it does not justify a broken state
between workstreams.

Write the spec for the workstream as scoped. Do not silently split it, absorb
a neighbor's work, or edit the manifest. If that scope cannot form an
independently green checkpoint, explain the structural defect through
\`replan\` instead of authoring an impossible spec. Use \`unmet\` only for a
requirement no workstream provides.
`.trim();

function scopeBlock(scope: WorkstreamScope): string {
  const lines = [scope.summary];
  if (scope.includes.length > 0) {
    lines.push("", "In scope:");
    for (const item of scope.includes) lines.push(`  - ${item}`);
  }
  if (scope.excludes.length > 0) {
    lines.push("", "Explicitly NOT in scope:");
    for (const item of scope.excludes) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

function rosterSection(sources: AuthorBriefSources): string {
  const entries = sources.roster.map((entry) => {
    const marker = entry.id === sources.target.id ? " (this workstream)" : "";
    const body = scopeBlock(entry.scope)
      .split("\n")
      .map((line) => (line === "" ? "" : `  ${line}`))
      .join("\n");
    return `### ${entry.id}: ${entry.name}${marker}\n\n${body}`;
  });

  return [
    "## Every workstream in this program",
    "",
    "This roster tells you **what exists**, not how any of it works.",
    "",
    "Read it before you write anything. Use it to notice that another",
    "workstream already owns something you were about to build, or produces",
    "something you need. An exclusion is as informative as an inclusion: if a",
    "workstream explicitly does not cover something you depend on, either it",
    "belongs to you or nobody has it.",
    "",
    "It is **not** enough to write against. If you need to conform to another",
    "workstream's output — its types, its function signatures, its file",
    "layout — do not infer them from a scope line. Name it in `needs` and you",
    "will be re-run with its actual spec in hand.",
    "",
    entries.join("\n\n"),
  ].join("\n");
}

function dependencySection(sources: AuthorBriefSources): string {
  if (sources.dependencySpecs.length === 0 && sources.demoted.length === 0) {
    return [
      "## Your dependencies",
      "",
      "This workstream declares no dependencies. If that turns out to be",
      "wrong, say so through `dependencies` and `needs` — the manifest is",
      "corrected from what you report, not the other way around.",
    ].join("\n");
  }

  const parts = [
    "## Your dependencies, in full",
    "",
    "These workstreams' specs are already written and settled. You consume",
    "their output, so they decide the shape and you match it — conform to",
    "what they define rather than restating or redesigning it.",
    "",
  ];

  for (const spec of sources.dependencySpecs) {
    parts.push(`### ${spec.id} — ${spec.path}\n\n\`\`\`markdown\n${spec.content}\n\`\`\`\n`);
  }

  if (sources.demoted.length > 0) {
    parts.push(
      "",
      `These direct dependencies were too large to include in full and appear only in the roster above: ${sources.demoted.join(", ")}. If you need one of them to write this spec correctly, name it in \`needs\` rather than guessing.`,
    );
  }

  return parts.join("\n");
}

function documentBlock(label: string, content: string): string {
  return `### ${label}\n\n\`\`\`\n${content}\n\`\`\`\n`;
}

function contextSection(sources: AuthorBriefSources): string {
  const parts = [
    documentBlock("Program document", sources.programDoc),
    documentBlock("Manifest", sources.manifest),
  ];
  if (sources.vision) parts.push(documentBlock("Vision", sources.vision));
  if (sources.agentsMd) parts.push(documentBlock("AGENTS.md", sources.agentsMd));
  for (const doc of sources.contextDocs) {
    parts.push(documentBlock(`Context: ${doc.path}`, doc.content));
  }
  return `## Program context\n\n${parts.join("\n")}`;
}

function outputContract(target: AuthorTarget): string {
  return `
## Output

Write the spec to \`${target.taskFile}\`. Do not create or edit any other
file, and do not commit.

Then reply with one fenced \`\`\`json block:

\`\`\`json
{
  "filesTouched": [
    { "path": "src/foo.ts", "action": "MODIFY", "note": "optional short note" }
  ],
  "dependencies": ["WS-03"],
  "needs": ["WS-12"],
  "unmet": ["token rotation for the admin session"],
  "replan": ["WS-04 deletes the shared type before WS-06 migrates its consumers"]
}
\`\`\`

**dependencies** — every workstream this one consumes output from. The
complete list, including any the manifest does not declare yet. Declaring one
is not a request for permission: if this spec reads another workstream's
types, calls its functions, or builds on its files, say so and the runner
records it. An empty list means this workstream genuinely stands alone.

**needs** — dependencies whose full spec you did not have and cannot write
this spec correctly without. Naming one here is the right move, not a
failure: you will be re-run with that spec in the brief. Guessing at an
interface you could have asked for is the failure.

**filesTouched** — every file listed in the spec's "Files Touched" section,
exactly once. "action" must be exactly "NEW", "MODIFY", or "DELETE". The
pipeline renders the final Markdown annotations from this array; do not put
action words only in prose. Use an empty array only when the spec truly has no
file changes.

**unmet** — things this workstream requires that **no** workstream in the
roster provides. That is a gap in the program, not in your spec; it goes back
to planning. Leave the array empty unless you really checked the roster.

**replan** — structural reasons this workstream cannot be implemented as one
independently green checkpoint, including unsafe migration ordering or a
scope that must be decomposed. Do not use it for ordinary implementation
difficulty. When this list is non-empty, explain the issue precisely; the
runner stops before later workstreams and returns the program to planning.
`.trim();
}

export function composeAuthorBrief(sources: AuthorBriefSources): string {
  const { target } = sources;
  return [
    `# Author the workstream spec for ${target.id}: ${target.name}`,
    "",
    `Program: ${sources.programId}. You are writing exactly one spec — ${target.id} — and nothing else.`,
    "",
    "## What this workstream covers",
    "",
    scopeBlock(target.scope),
    "",
    rosterSection(sources),
    "",
    dependencySection(sources),
    "",
    contextSection(sources),
    "",
    AUTHORING_RULES,
    "",
    "### Spec template",
    "",
    "Match an existing spec under `tasks/` when one exists. Otherwise use:",
    "",
    "```markdown",
    SPEC_TEMPLATE,
    "```",
    "",
    outputContract(target),
    "",
    summaryContract(),
  ].join("\n");
}
