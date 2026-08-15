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

If no vision document exists at the resolved path, stop. Explain that it should contain the product
description, architecture, target users, API surface, data model, phase scope,
and technology stack. For a new repository, suggest the `init-project` skill.

If `docs/as-built.md` is absent, note that this is likely the first program and proceed.

## 2. Gather requirements

Resolve these values from the arguments or ask for anything missing:

1. The feature set or phase to build.
2. A lowercase, hyphenated program ID, such as `phase-2-durable`.

Wait for the user's response when questions are required.

## 3. Draft the program document

Inspect `docs/programs/` for an existing `*-program.md`. Match its structure when one exists. Otherwise use:

```markdown
# {Project Name} — Program Plan ({Program Name})

## Program Overview
**Product:** [From the vision.]
**Program scope:** [What this program delivers.]

## Strategic Goals
[Three to five outcome-focused bullets.]

## Architecture Changes
[Changes from the system in as-built.md. For the first program, describe the full architecture.]

## Technology Choices
[Only new choices. If none: "No new technology — uses existing stack."]

## Workstreams
| ID | Workstream | Dependencies | Estimated Effort |
|----|------------|--------------|------------------|
[All workstreams.]

**Size key:** S = 1–2 days, M = 3–5 days, L = 5–10 days

## Dependency Graph
[ASCII workstream dependency flow.]

## Critical Path
[The longest dependency chain.]

## Scope (In)
[Included deliverables.]

## Scope (Out)
[Explicit exclusions.]

## Risk Register
| Risk | Impact | Mitigation |
|------|--------|------------|
[Key risks.]

## Success Criteria
[Stable IDs, `SC-01`, `SC-02`, and so on, paired with numbered, verifiable outcomes.]
```

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
    "created": "{YYYY-MM-DD}"
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

## 5. Hand off for review

Both files now exist on disk. Reply with a short summary only — program
scope in a sentence, workstream count, critical path, and links to the two
file paths — and invite the user to review the files and request changes.
Apply any requested edits to the files in place.

Do not create workstream specs in this workflow, and do not offer to. Specs
are written by the packaged runner, one clean agent per workstream:

```sh
npx --yes @wildorder/program-pipeline author "{program-id}"
```

Point the user at that command and stop. Authoring a spec inside this session
would write it in a context already carrying the whole planning conversation,
compose its own instructions, and then grade its own output — which is what
the command exists to prevent.

## Rules

- Describe only new behavior. Reference `docs/as-built.md` for unchanged capabilities.
- Keep each workstream completable in one agent session, roughly 200–300 turns.
- Split a workstream that touches more than eight core files.
- List every package or directory each workstream touches.
- Use stable `SC-xx` success-criteria IDs for downstream traceability.
- Give every workstream a `scope` with a specific `summary`, and state
  `excludes` wherever a neighbor might reasonably assume coverage. Authoring
  reads these and refuses to run without them.
