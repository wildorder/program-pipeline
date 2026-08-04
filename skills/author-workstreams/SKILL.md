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

Resolve the author from `--author-model`, then `models.author` in
`pipeline.config.json`, then the host's current model.

Resolve the validator in this order — stop at the first mechanism that
works in the current host:

1. Explicit `--validator-model` flag, when the host can run that model.
2. **In-host switch**: `models.validator` from `pipeline.config.json`, when
   the host can select that model or spawn a subagent with it (billing flows
   through the host).
3. **External validator agent**: the `validatorAgent` command from
   `pipeline.config.json`, run as a separate process — pipe it the
   validation instructions plus the spec, manifest, and program document
   contents, since it shares no session context (billing flows through that
   CLI's own account). This is how a cross-provider validator works from
   hosts that cannot switch providers.
4. Otherwise: validate with the current model and report the validation as
   same-model rather than independent.

Entries in `models` are host-neutral intent (for example `opus-5`, `sol`),
not host-specific slugs. Resolve each to the nearest concrete model the
current host offers and state the mapping (for example "author `opus-5` →
`claude-opus-5-thinking-high` in this host"). Do not offer to rewrite
`pipeline.config.json` with host-specific slugs — the config must stay
host-neutral so every host and teammate can resolve it.

Before authoring, state which model fills each role, where the choice came
from (flag, config, external agent, or default), and which mechanism will
run the validator, so the user can object before work begins.

**Guardrail — independent validation:** if the resolved validator is the same
model as the author, warn that same-model validation weakens the gate
(correlated errors) and ask whether to proceed anyway or pick a different
validator.

Do not assume provider-specific model names. If the user requests an
unavailable model, stop and ask them to choose from the host's supported
models.

**Self-heal stale model names:** when the host or an agent CLI reports a
configured model as unavailable, obsolete, or renamed, do not silently
substitute and do not edit any skill file. Identify the current equivalent,
propose updating `pipeline.config.json` (the single source of truth for
model roles), apply the fix after the user approves, and retry.

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

**Fail fast on role errors.** If a subagent or the configured author model
fails for operational reasons — cost or usage limits, rate limiting,
authentication, model unavailable — stop the entire authoring run at the
first failure. Do not spin up further subagents, do not retry blindly, and
never silently author the specs yourself with a different model: that swaps
the configured author for another model without consent. Report which
workstream failed, the exact error, and the options — wait and retry, change
`models.author` in `pipeline.config.json`, or explicitly approve continuing
with the current session model — and wait for the user's decision.

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
