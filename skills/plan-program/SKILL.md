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

- `docs/vision.md`, the anchor product vision.
- `docs/as-built.md`, when present, for current system state.
- `AGENTS.md` for repository directives and conventions.

If `docs/vision.md` is absent, check `pipeline.config.json` for `visionPath`,
then any legacy repository override configuration such as `.cursor/rules/`.
If no vision document exists, stop. Explain that it should contain the product
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

Present the draft for approval before generating or saving the final manifest.

## 4. Generate the manifest after approval

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
      "taskFile": "tasks/{program-id}/{ws-slug}.md",
      "status": "not_started",
      "size": "S|M|L",
      "dependencies": [],
      "packages": []
    }
  ],
  "outOfScope": []
}
```

## 5. Save

After approval, save:

- `docs/programs/{program-id}-program.md`
- `docs/programs/{program-id}-manifest.json`

Do not create workstream specs in this workflow. That belongs to `author-workstreams`.

## Rules

- Describe only new behavior. Reference `docs/as-built.md` for unchanged capabilities.
- Keep each workstream completable in one agent session, roughly 200–300 turns.
- Split a workstream that touches more than eight core files.
- List every package or directory each workstream touches.
- Use stable `SC-xx` success-criteria IDs for downstream traceability.
