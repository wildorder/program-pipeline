---
name: author-workstreams
description: Author every workstream specification for a program and run the standard hard validation gate. Use after program planning to create self-contained implementation specs with traceability, interfaces, tests, and acceptance criteria.
argument-hint: "<program-id> [--no-validate | --validate-only | --fix-and-validate] [--author-model <id>]"
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

Resolve the author from `--author-model`, then `models.author` in
`pipeline.config.json`, then the host's current model.

Entries in `models` are host-neutral intent (for example `opus-5`, `sol`),
not host-specific slugs. Resolve each to the nearest concrete model the
current host offers and state the mapping (for example "author `opus-5` →
`claude-opus-5-thinking-high` in this host"). Do not offer to rewrite
`pipeline.config.json` with host-specific slugs — the config must stay
host-neutral so every host and teammate can resolve it.

**Validation is not yours to configure.** The packaged runner resolves the
critic and writer from the `authorAgent` and `validatorAgent` blocks and
composes their briefs itself. Note that `models.author` governs only in-host
authoring — it does not reach the runner, so a strong `models.author` with no
`authorAgent` configured still leaves the loop running the build agent. You do not pick the validator, pipe it context, or tell
it what to weigh — that seam is how "ignore length, ignore file counts"
instructions used to reach a supposedly independent validator and quietly
narrow the gate. Report which agents the runner names for each role so the
user can object; the runner aborts on its own if either is missing.

Before authoring, state which model authors the specs and where that choice
came from, so the user can object before work begins.

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
[One list item per touched file: `- \`path/to/file.ts\` (NEW)` or
`(MODIFY — optional short note)`. Only list items are validated as file
entries; keep context about untouched files in prose or blockquotes, not
bullets.]

## Existing Interfaces to Consume
[Paste 10–30 lines of the actual interfaces consumed from existing code.
Omit only when this is the first program and no relevant code exists.]

## Implementation Steps
[Precise, intentionally ordered, numbered steps.]

## Tests
[Numbered cases, each naming the scenario, expected behavior, and assertions.
Write tests that discriminate: see the test-quality rules below.]

## Acceptance Criteria
[Numbered, objectively verifiable completion conditions.]
```

Save each spec to the exact `taskFile` path in the manifest, normally `tasks/{program-id}/{ws-id}-{slug}.md`.

## 4. Validate unless disabled

Unless `--no-validate` is present, hand the specs to the packaged convergence
loop and treat it as a hard gate:

```sh
npx --yes @wildorder/program-pipeline converge "{program-id}"
```

The runner owns the loop: it composes the validator brief itself, alternates
critic and writer between the two configured agents so neither grades its own
writing, and applies the cause-required severity policy. Do not compose the
validator's instructions, tell it what to ignore, or re-adjudicate its
findings — see `validate-workstreams` for the full contract.

- Report the gate result, the loop outcome, and blocker/major/minor/advisory
  counts.
- Put `blocker` findings first and return `FAILED` when any exist.
- Surface open disagreements for the user to settle rather than resolving them.
- On `requires-replan`, stop and refer back to `plan-program`; further spec
  polish on a workstream that must be split is wasted.
- With `--validate-only`, run the loop with `--rounds 1` so the critic reports
  without a writer pass.
- When the gate passes, mark the specs ready for `review-program`.

If the loop aborts — a missing `validatorAgent`, a usage limit, an
authentication failure — do not claim a pass. Report validation as not run and
name the missing capability.

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

### Test quality

Naming a scenario, an expected behavior, and an assertion target satisfies the
mechanical contract and still permits worthless tests. Validation now judges
whether the tests are *good*, so write them that way:

1. **Discriminate.** A plausible wrong implementation must fail. A test that
   asserts a mock was called, or that a result is truthy, proves nothing.
   State the concrete expected value, not its shape.
2. **Cover every acceptance criterion.** Each numbered criterion needs at
   least one test that could actually fail. A criterion nothing can falsify
   is not verified.
3. **Reach the failure paths.** If the spec names error handling, boundary
   values, empty inputs, or concurrency, test them — not just the happy path.
4. **Bind to public behavior.** Assert at the module boundary the spec
   defines, not on internals that the next refactor will churn.

Weak tests are raised as a `major` finding in the `test-quality` category.

### Scope and length

There is no line-count cap. Never remove useful interfaces, steps, tests, or acceptance criteria to meet an arbitrary length.

Size workstreams by:

1. One implementation session, roughly 200–300 agent turns.
2. About eight core files as the practical target; more than ten is a strong split signal. Exclude companion tests and barrel re-exports from this count.
3. One cohesive concern.

If the manifest defines oversized workstreams, recommend revisiting
`plan-program`; do not split workstreams or rewrite the manifest during
authoring unless explicitly asked.
