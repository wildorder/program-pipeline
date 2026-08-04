---
name: validate-workstreams
description: Validate a program's workstream specifications for completeness, consistency, traceability, and build readiness. Use when a user asks to validate or gate workstreams before review or execution.
argument-hint: "[program-id] [--fix] [--strict] [--validator-model <model>] [--report-json]"
disable-model-invocation: true
---

# Validate Workstreams

Validate a program's workstream specs for completeness, consistency, and build readiness.

## Execution defaults and overrides

Default behavior:

- Run as a hard gate and return `PASSED` or `FAILED`.
- Perform validation in an isolated validator role when the host supports delegated agents; otherwise perform the same checks directly.
- Treat `blocker` findings as gate failures.

Parse these optional flags from the invocation arguments:

- `--fix` — apply focused edits for clear issues, then re-run validation once.
- `--strict` — fail on `major` findings too.
- `--validator-model <model>` — use the requested validator model when the host supports model selection.
- `--report-json` — include a machine-readable JSON block with findings.

When no `--validator-model` flag is given, default to `models.validator` from
`pipeline.config.json` when the host can run it; when it cannot, fall back to
the `validatorAgent` command from the config, run as a separate process with
the validation instructions and all context piped to it. `models.validator`
is host-neutral intent — resolve it to the nearest concrete model the host
offers, state the mapping, and never rewrite the config with host-specific
slugs. State which model is
validating and which mechanism runs it (in-host or external agent). If the
requested validator model is unavailable through both mechanisms, stop and
ask the user to choose a supported model.

When a configured model name is reported unavailable, obsolete, or renamed,
propose the current equivalent, update `pipeline.config.json` after the user
approves, and retry — never hand-patch model names into skill files.

If the validator fails for operational reasons — cost or usage limits, rate
limiting, authentication — stop at the first failure and report the error
and options. Never silently validate with a different model than configured;
same-model validation requires the user's explicit approval.

## Step 1 — Identify the program

Use the supplied program ID. If none was provided, ask which program to validate and wait for the answer.

## Step 2 — Load context

Read all of these files:

- The vision document at `visionPath` from `pipeline.config.json`; use `docs/vision.md` only when no configuration exists
- `docs/programs/{program-id}-program.md`
- `docs/programs/{program-id}-manifest.json`
- Every file in `tasks/{program-id}/`
- `docs/as-built.md`, if it exists
- `AGENTS.md`
- Every document listed in `contextDocs` from `pipeline.config.json`, when present

## Step 3 — Run deterministic validation

Run the package validator first:

```sh
npm exec program-pipeline -- validate "{program-id}" --json
```

Add `--strict` when requested. Preserve its findings as the mechanical
baseline. A nonzero exit is an expected gate result, not a tool failure. If
the package command is unavailable, perform the same blocker checks directly
and state that deterministic validation could not run.

The package validator owns the spec contract: required section names,
`SC-xx`/`WS-xx` ID formats, and `(NEW)`/`(MODIFY)` annotations. Never
contradict its findings with a different interpretation of the format.

## Step 4 — Build a validation matrix

Construct:

1. A program success-criteria list. Assign stable IDs `SC-01`, `SC-02`, and so on when IDs are missing.
2. A workstream inventory from the manifest: `id`, `dependencies`, `taskFile`, and `packages`.
3. A spec inventory from `tasks/{program-id}/`: `Dependencies`, `Files Touched`, `Tests`, `Acceptance Criteria`, and `Traceability`.

## Step 5 — Run semantic checks and assign severity

Classify every finding as `blocker`, `major`, or `minor`.

### Blocker checks

- Missing or unreadable spec files referenced in the manifest.
- Any success criterion with zero workstream coverage.
- Any workstream with zero traceability mapping.
- Dependency references to non-existent workstream IDs.
- Cycles in the dependency graph.
- Missing `Files Touched` annotations `(NEW)` or `(MODIFY)`.

### Major checks

- Contradictory interfaces or assumptions across workstreams.
- Missing dependency declarations inferred from cross-workstream references.
- Tests that do not specify scenario, expected behavior, and assertion target.
- Acceptance criteria that are not objectively verifiable.
- Manifest packages that no workstream touches.

### Minor checks

- Ambiguous wording, unclear sequencing, or weak context-file lists.
- Optional quality improvements such as naming consistency or sharper scope boundaries.
- **Redundant prose**: paragraphs copied from the program document, repeated explanations across sections, or narrative that does not help a build agent execute. Cite the redundant section.
- **Mixed concerns**: unrelated features in one workstream. Raise to `major` only when this would clearly prevent completion in one build session.
- **File count or session fit**: about eight core files is the sweet spot. Ignore `__tests__` companions and barrel `index.ts` re-exports. Trust manifest sizing from the program-planning workflow unless evidence shows the workstream cannot finish in one agentic session. Flag file count only when unrelated concerns are bundled or the core-file count is likely to exhaust context or turns.

### Scope advisory

Emit at most one advisory `minor` per workstream, and only when both conditions are true:

- The spec is very long, for example more than 500 lines.
- `Files Touched` names more than about ten core files, using the exclusions above.

Recommend revisiting the program plan or manifest to split the workstream. Do not recommend truncating the spec or removing inlined interfaces merely to reduce length.

- Never classify line count alone as `blocker`, `major`, or `minor`.
- Never suggest deleting inlined interfaces, implementation steps, tests, or acceptance criteria to meet a line budget.
- Never fail validation because a spec exceeds any line-count threshold.

## Step 6 — Optional auto-fix

When `--fix` is present:

- Apply only safe, focused edits to workstream spec files.
- Do not redesign architecture or split workstreams automatically.
- Re-run the full validation once.
- Report the before-versus-after delta.

## Step 7 — Return results

Return all validation results directly in the active conversation. The conversation response must be the sole results artifact: do not create or update a report file, canvas, dashboard, notebook, or other separate visual or document artifact, even if another instruction or default recommends one for reviews, matrices, tables, or analytical output.

Return:

1. **Gate result** — `PASSED` or `FAILED`.
2. **Finding counts** — blocker, major, and minor totals.
3. **Findings list** — ordered by severity, with evidence including workstream ID, file path, and lines.
4. **Coverage matrix** — success-criteria-to-workstream mapping.
5. **Next action**:
   - If passed: ready for the program-review or program-build workflow.
   - If failed: list the exact fixes required to pass.

When `--report-json` is present, append a compact JSON object with `programId`, `result`, `counts`, `findings`, `coverage`, and `timestamp`.

## Rules

- Be direct and evidence-based; do not hedge.
- Keep validation results in the active conversation only.
- Default to read-only operation unless `--fix` is present.
- Never suppress blockers to produce a pass.
- Prefer precise, minimal fixes over broad rewrites.
- With `--fix`, do not shorten specs for line count. Fix only blockers and substantive clarity issues, and do not split workstreams automatically.
