---
name: plan-program
description: Plan a new engineering program or product phase, define architecture changes and workstreams, and produce the canonical program document and manifest. Use when turning a feature set into an executable program plan.
argument-hint: "[program-id] [feature-set-or-phase]"
disable-model-invocation: true
---

# Plan a program

Plan a new feature set or phase for the current project.

## 1. Load project context

Read:

- The vision document at `visionPath` from `pipeline.config.json`, the anchor
  product vision. Use `docs/vision.md` only when no configuration exists.
- `docs/as-built.md`, when present, for current system state.
- `AGENTS.md` for repository directives and conventions.
- Every document listed in `contextDocs` from `pipeline.config.json`, when present.

### Replanning handoff

When a program ID is supplied, check for
`docs/programs/{program-id}-replan.json` before drafting anything. If it
exists, this is a replan rather than an isolated new planning session.

#### Human-required decisions come first

When the report's `outcome` is `"human-required"`, the pipeline stopped
because the critic found one or more genuine user-intent decisions that no
wording repair can resolve. `humanDecisionReason` states them. Before editing
any artifact:

1. Present each decision to the user as an explicit either/or choice, quoting
   the incompatible requirements and citing the relevant findings and
   `criteriaPatches` from the report.
2. Wait for the user's answer to every decision. Do not pick a side yourself,
   and do not proceed with a subset answered.
3. Record each decision and its rationale in the program document (a short
   "Requirements Decisions" section is sufficient). The user's recorded
   decisions are the only authorization for changing success criteria or
   user intent; apply exactly what was decided, nothing more.

Then continue with the full replan protocol below, treating the report's
findings and class analyses as the closure obligations they are.

For any report, read:

- `lastAttempt` first when present. When its outcome is `rejected`, the attempt
  was rolled back, so its edits are not canonical; treat every `failedSubjects`
  entry as the priority closure set and use `reason` to avoid repeating the
  rejected proof or consistency defect. Read `attemptHistory` for earlier
  retry failures from the same handoff;
- the complete replan report, treating every `replanFindings` entry as a
  mandatory structural defect to resolve;
- every `relatedFindings` entry and `checkpointAssessments` entry so the new
  plan does not preserve a known interface, coverage, dependency, or test
  defect merely because it was not itself marked `requiresReplan`;
- every `classAnalyses` entry. Treat its `checkedSubjects` as a closure
  obligation: inspect the whole set, repair every `affectedSubjects` member,
  and fix the stated root cause rather than only the example that triggered
  the report;
- `criteriaPatches`, applying only entries explicitly classified as
  intent-preserving clarifications. Any other success-criteria or user-intent
  change requires a human decision;
- the existing program document and manifest;
- every task file referenced by the existing manifest;
- the current git status and the actual source files cited by the report's
evidence.

For each blocker or major finding, add a reconciliation table to the program
document naming every `classAnalyses.checkedSubjects` member, its disposition
(`fixed` or `already-correct`), and concrete file/line or artifact evidence.
Every `affectedSubjects` member must be `fixed`. Evidence only in the chat
summary does not count: the durable artifacts are the review surface.
If a criterion names a conceptual family of commands, routes, schemas, or
interfaces, derive the complete set from the repository's canonical registry,
union, manifest collection, or the criterion's explicit list. Never fix one
counterexample and leave equivalent members for the next replan.

For every criterion or interface repair, reconcile all canonical copies: the
manifest criterion, architecture/design prose that references it, and every
relevant `workstreams[].scope.includes/excludes` entry. The manifest is the
single source of truth for criteria, workstreams, and scope — when the
program document restates manifest data (older programs did), resolve the
duplication by replacing the restatement with an `SC-xx`/`WS-xx` reference,
never by synchronizing two copies. Search for superseded
phrasing after the edit and explain any intentional remaining occurrence.
Resolve conditional members such as "only if one exists" against the actual
repository before placing them in an asserted-equal set.

Plan from the repository state that exists now, not from the original
pre-program design. A workstream marked complete is baseline only when its
implementation is present and the configured verification commands are green.
If the partially executed repository is red, say so explicitly and make
restoring the canonical gate the first recovery checkpoint; no later
workstream may depend on an assumed green state.

Rewrite the existing program document and manifest in place. Set or advance a
unique `program.planGeneration` value (an ISO timestamp plus a short random
suffix is sufficient) on every new plan or replan. Every replacement task spec
must carry the matching marker `<!-- program-pipeline:plan-generation=<value> -->`;
the packaged author runner stamps this marker after writing as a safety net.
Treat genuinely
landed work as current architecture rather than scheduling it again. Give
replacement work new workstream IDs and new task-file paths so downstream
authoring never overwrites the superseded specs; old unreferenced specs remain
historical evidence. The new dependency graph must causally resolve every
unsafe checkpoint, and the final handoff summary must link the replan report
alongside the replacement program and manifest.

If no vision document exists at the resolved path, stop. Explain that it should contain the product
description, architecture, target users, API surface, data model, phase scope,
and technology stack. For a new repository, suggest the `init-project` skill.

If `docs/as-built.md` is absent, note that this is likely the first program and proceed.

## 2. Gather requirements

Resolve these values from the arguments or ask for anything missing:

1. The feature set or phase to build.
2. A lowercase, hyphenated program ID, such as `phase-2-durable`.

Wait for the user's response when questions are required.

### Select the execution mode

Choose the mode before decomposing the work and record the decision in both
artifacts. Default to `atomic` unless there is positive causal evidence that
orchestration is necessary.

- **`atomic`** — one cohesive agent working set, one implementation brief, and
  one green commit. Choose this when a capable coding agent can own the whole
  change coherently and intermediate deployable checkpoints add no material
  safety or parallelism. Approximate size near a configured token band is not
  a reason to reject atomic mode.
- **`orchestrated`** — multiple independently-green workstreams executed as a
  dependency graph. Choose this when the minimum static context physically
  cannot fit one agent session, independent work provides material parallelism,
  independently deployable service boundaries matter, or a shared-contract
  migration requires expand -> migrate consumers -> contract/delete ordering.

Do not choose orchestrated merely because the feature is important, spans many
files, or has a high estimated token count. State the concrete evidence in
`program.executionModeReason`. In atomic mode create exactly one workstream
covering the entire program, with no dependencies and task file
`tasks/{program-id}/implementation.md`; the entire program is its one
independently-green checkpoint. In orchestrated mode use the decomposition and
checkpoint rules below.

## 3. Draft the program document

Inspect `docs/programs/` for an existing `*-program.md`. Match its structure when one exists. Otherwise use:

```markdown
# {Project Name} — Program Plan ({Program Name})

## Program Overview
**Product:** [From the vision.]
**Program scope:** [What this program delivers.]

## Execution Mode
**Mode:** atomic | orchestrated
**Reason:** [Concrete causal evidence for the choice.]

## Strategic Goals
[Three to five outcome-focused bullets.]

## Architecture Changes
[Changes from the system in as-built.md. For the first program, describe the full architecture.]

## Technology Choices
[Only new choices. If none: "No new technology — uses existing stack."]

## Risk Register
| Risk | Impact | Mitigation |
|------|--------|------------|
[Key risks.]

## Success Criteria, Workstreams, and Scope
Canonical in `docs/programs/{program-id}-manifest.json`: success-criteria
text, the workstream roster, dependencies, sizes, scope, and exclusions live
there and only there. This document refers to them by id (`SC-xx`, `WS-xx`)
and never restates their text.
```

The program document carries only what the manifest cannot: narrative
architecture, causal reasoning, and risks. Success criteria, the workstream
table, the dependency graph, critical path, and scope in/out lists are
manifest data — do not reproduce them here. Two copies of the same fact drift
apart, and every drifted copy becomes a plan-audit finding and a replan
closure obligation. When this section's rule and an older program document's
structure conflict, this rule wins: delete the duplicated sections rather
than matching them.

Write the draft directly to `docs/programs/{program-id}-program.md`. Do not
paste the document into the conversation or ask for approval before saving —
the file is the review surface, not the chat window.

## 4. Generate the manifest

If `docs/programs/` contains an existing `*-manifest.json`, match its schema exactly. Otherwise use:

```json
{
  "program": {
    "id": "{program-id}",
    "name": "{Program Name}",
    "description": "{one-line description}",
    "status": "planning",
    "created": "{YYYY-MM-DD}",
    "executionMode": "atomic|orchestrated",
    "executionModeReason": "{concrete causal evidence}"
  },
  "technology": {},
  "successCriteria": [
    { "id": "SC-01", "description": "{verifiable outcome}" }
  ],
  "packages": [
    {
      "name": "{package-name}",
      "path": "{relative-path}",
      "description": "{purpose}"
    }
  ],
  "workstreams": [
    {
      "id": "WS-01",
      "name": "{Workstream Name}",
      "taskFile": "tasks/{program-id}/{ws-id}-{slug}.md",
      "status": "not_started",
      "size": "S|M|L",
      "scope": {
        "summary": "{one line: what this workstream owns}",
        "includes": ["{specific thing it covers}"],
        "excludes": ["{specific thing it deliberately does not cover}"]
      },
      "dependencies": [],
      "packages": []
    }
  ],
  "outOfScope": []
}
```

Save it directly to `docs/programs/{program-id}-manifest.json`.
Keep the manifest, program document, replan report, and every referenced
`taskFile` trackable by Git. If the repository ignores `tasks/` or
`docs/programs/`, remove those ignore rules (or explicitly force-add these
canonical artifacts); a plan that exists only in an ignored working tree is
not reproducible on CI or another machine.

For `atomic`, the `workstreams` array contains exactly one whole-program
workstream (`WS-01`) whose `taskFile` is
`tasks/{program-id}/implementation.md`. For `orchestrated`, it contains the
dependency graph described in the program document.

### Scope is load-bearing, not decoration

`scope` is required. `program-pipeline author` refuses to run without a
`scope.summary` on every workstream, and the reason is worth understanding
before you write them.

Authoring spawns one clean agent per workstream, and every one of those
agents is handed the roster of the whole program — each workstream's id,
name, and scope, and nothing else. That roster is how an author discovers
that another workstream already owns something it was about to build, or
produces something it needs. An author that cannot tell what `WS-12` covers
will not merely omit a dependency; it will reimplement WS-12's work.

So write these for a reader who has no other information about that
workstream:

- **`summary`** — one line naming what it owns. "Auth improvements" tells an
  author nothing. "Issues, rotates, and validates auth tokens" tells it
  everything it needs to decide whether to depend on this.
- **`includes`** — the specific capabilities inside the boundary.
- **`excludes`** — the specific capabilities deliberately outside it. These
  carry more weight than they look. An exclusion tells every other author
  that something is *not* covered here, which prevents both duplicated work
  and a requirement that silently belongs to nobody. If a workstream's
  neighbors might reasonably assume it handles something, say that it does
  not.

### Every orchestrated workstream is an independently green checkpoint

Design the roster so that, starting from a green repository containing only
its declared dependencies, each workstream can finish with every configured
build, typecheck, test, and lint command still green. A later workstream must
never be required to repair an earlier checkpoint.

For a shared contract migration, prefer an explicit sequence:

1. **Expand** — introduce the new contract while preserving compatibility.
2. **Migrate** — move bounded consumer groups in independently green batches.
3. **Contract/delete** — remove the compatibility surface only after every
   consumer migration is complete.

The destructive cleanup depends on every migration workstream. Do not place
foundational deletion first merely because it is conceptually central.

For atomic mode, the whole program is the checkpoint; do not invent internal
workstreams solely to manufacture intermediate gates.

Execution size is a separate concern from checkpoint safety. Read
`build.executionProfile` from `pipeline.config.json` when present. Treat its
target, caution, and hard working-set values as broad risk bands, not precise
pass/fail numbers: a small estimated overage is noise and must not trigger a
split. Reconsider a workstream that is grossly above the hard band, but allow
a cohesive workstream to proceed with a clear justification. Only a minimum
static input that physically cannot fit the configured context window is an
automatic sizing failure. The author command performs the deterministic
estimate after specifications name concrete files.

## 5. Hand off for review

Both files now exist on disk. Reply with a short summary only — program
scope in a sentence, selected execution mode and reason, workstream count,
critical path, and links to the two
file paths — and invite the user to review the files and request changes.
Apply any requested edits to the files in place.

Do not create workstream specs in this workflow, and do not offer to. Specs
are written by the packaged runner, one clean agent per workstream:

```sh
npx --yes @wildorder/program-pipeline run "{program-id}"
```

The run begins with an independent `plan-audit` before authoring. Point the
user at that command — or at `/run-program {program-id}`, which starts the
same run with the agent watching it as a non-interfering orchestrator — and
stop. Authoring a spec inside this session
would write it in a context already carrying the whole planning conversation,
compose its own instructions, and then grade its own output — which is what
the command exists to prevent.

## Rules

- Describe only new behavior. Reference `docs/as-built.md` for unchanged capabilities.
- Keep each workstream completable in one agent session and independently
  green; use causal boundaries and the configured execution bands instead of
  hard line-count or file-count rules.
- List every package or directory each workstream touches.
- Use stable `SC-xx` success-criteria IDs for downstream traceability.
- The manifest is the single source of truth for success criteria,
  workstreams, dependencies, and scope. The program document references them
  by id and never restates their text.
- Give every workstream a `scope` with a specific `summary`, and state
  `excludes` wherever a neighbor might reasonably assume coverage. Authoring
  reads these and refuses to run without them.
