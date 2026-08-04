---
name: author-workstreams
description: Author every workstream specification for a program and run the standard hard validation gate. Use after program planning to create self-contained implementation specs with traceability, interfaces, tests, and acceptance criteria.
argument-hint: "<program-id> [--no-validate | --validate-only | --fix-and-validate] [--author-model <id>] [--validator-model <id>]"
disable-model-invocation: true
---

# Author workstreams

Generate all workstream task specs for a program, then validate them by default.

## Execution modes

Parse these optional flags from the invocation:

- `--no-validate`: author specs without the automatic validation pass.
- `--validate-only`: do not author; validate existing specs.
- `--fix-and-validate`: after failed validation, make focused spec fixes and validate once more.
- `--author-model <id>`: use the requested available model for authoring when the host supports model selection.
- `--validator-model <id>`: use the requested available model for validation when the host supports model selection.

Resolve the author and validator in this order:

1. Explicit `--author-model` / `--validator-model` flags.
2. `models.author` and `models.validator` from `pipeline.config.json`.
3. Otherwise: the host's current model for authoring and an independent
   validation pass.

Before authoring, state which model fills each role and where that choice
came from (flag, config, or default), so the user can object before work
begins.

**Guardrail — independent validation:** if the resolved validator is the same
model as the author, warn that same-model validation weakens the gate
(correlated errors) and ask whether to proceed anyway or pick a different
validator. When the host cannot switch models or spawn a differently-modeled
subagent, say so explicitly and report the validation as same-model rather
than independent.

Do not assume provider-specific model names. If the user requests an
unavailable model, stop and ask them to choose from the host's supported
models.

## 1. Identify the program

Use the positional program ID when supplied. Otherwise ask for it and wait.

## 2. Load context

Read:

- `docs/programs/{program-id}-program.md`
- `docs/programs/{program-id}-manifest.json`
- The vision document at `visionPath` from `pipeline.config.json`; use
  `docs/vision.md` only when no configuration exists.
- `docs/as-built.md`, when present
- `AGENTS.md`
- Every document listed in `contextDocs` from `pipeline.config.json`, when present

## 3. Author every spec

Skip this step with `--validate-only`.

Generate and save all specs. Do not stop for approval after each one. Parallelize independent workstreams when the host supports parallel agents. If ambiguity requires judgment, make the best supported assumption, continue, and record it for the final report.

The section names, ID formats, and file annotations below are the contract
enforced by `program-pipeline validate`; the validator is canonical, so do not
rename its required sections (`Traceability`, `Files Touched`, `Tests`,
`Acceptance Criteria`) or the `SC-xx`/`WS-xx`/`(NEW)`/`(MODIFY)` formats.

Inspect `tasks/` for an existing workstream spec and match its structure. If none exists, use:

```markdown
# {WS-ID}: {Name}

## Goal
[What this workstream delivers and why.]

## Traceability
[Program success criteria satisfied, using stable IDs such as `SC-01`.]

## Dependencies
[Workstream IDs from this program that must finish first.]

## Context Files (Agent MUST read before implementing)
[Exact paths. Always include:
- `AGENTS.md`
- Relevant sections of `docs/vision.md`
- Specific source files consumed or modified
Do not include other workstream specs or program documents.]

## Package
[Target package or directory.]

## Files Touched
[Every file marked `(NEW)` or `(MODIFY)`.]

## Existing Interfaces to Consume
[Paste 10–30 lines of the actual interfaces consumed from existing code.
Omit only when this is the first program and no relevant code exists.]

## Implementation Steps
[Precise, intentionally ordered, numbered steps.]

## Tests
[Numbered cases, each naming the scenario, expected behavior, and assertions.]

## Acceptance Criteria
[Numbered, objectively verifiable completion conditions.]
```

Save each spec to the exact `taskFile` path in the manifest, normally `tasks/{program-id}/{ws-id}-{slug}.md`.

## 4. Validate unless disabled

Unless `--no-validate` is present, immediately run the repository's standard `validate-workstreams` workflow or command using the validator selected above. Treat validation as a hard gate.

- Put `blocker` findings first and return `FAILED` when any exist.
- Report blocker, major, and minor counts.
- With `--fix-and-validate`, make only targeted fixes to the specs and run validation one more time.
- With `--validate-only`, do not rewrite specs unless `--fix-and-validate` is also present.
- When there are no blockers, return `PASSED` and mark the specs ready for `review-program`.

If the standard validation capability is unavailable, do not claim a pass. Report validation as not run and identify the missing capability.

## 5. Report

Report:

1. Every spec created or updated.
2. `PASSED` or `FAILED`, plus blocker, major, and minor counts; if skipped or unavailable, say so explicitly.
3. Assumptions made.
4. Potential issues: oversized or mixed-concern workstreams, risky dependency ordering, and conflicts needing manual review. Line count alone is advisory, not a defect.

## Authoring rules

- Make every spec self-contained. An implementation agent reading that spec, `AGENTS.md`, and its Context Files must have everything needed.
- Include `Traceability` with at least one program success-criterion ID.
- Inline actual interface definitions instead of merely pointing at their files.
- Mark every file `(NEW)` or `(MODIFY)`.
- Order implementation steps intentionally.

### Scope and length

There is no line-count cap. Never remove useful interfaces, steps, tests, or acceptance criteria to meet an arbitrary length.

Size workstreams by:

1. One implementation session, roughly 200–300 agent turns.
2. About eight core files as the practical target; more than ten is a strong split signal. Exclude companion tests and barrel re-exports from this count.
3. One cohesive concern.

If the manifest defines oversized workstreams, recommend revisiting
`plan-program`; do not split workstreams or rewrite the manifest during
authoring unless explicitly asked.
