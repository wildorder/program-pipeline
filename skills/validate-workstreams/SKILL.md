---
name: validate-workstreams
description: Validate a program's workstream specifications for completeness, consistency, traceability, test quality, and build readiness. Use when a user asks to validate or gate workstreams before review or execution.
argument-hint: "[program-id] [--rounds <n>] [--strict] [--report-json]"
disable-model-invocation: true
---

# Validate Workstreams

Validate a program's workstream specs for completeness, consistency, test
quality, and build readiness.

## How this workflow runs

The packaged runner owns validation. Your job is to invoke it, read what it
returns, and report — **not** to compose the validator's instructions, decide
what it should ignore, or re-adjudicate its findings.

That separation is deliberate. When the orchestrating agent hand-assembled the
prompt for the external validator, it folded in its own framing — "ignore
length", "don't worry about file counts" — which narrowed the critique before
it started and produced passes that looked more thorough than they were. The
runner now builds the brief from the program's own files plus a fixed criteria
block. Do not attempt to supplement it.

Run:

```sh
npx --yes @wildorder/program-pipeline converge "{program-id}"
```

Add `--rounds <n>` (maximum 3) or `--strict` when the user asks. Use
`--json` when you need the machine-readable result. A nonzero exit is an
expected gate result, not a tool failure.

For a mechanical-only check with no agents involved:

```sh
npx --yes @wildorder/program-pipeline validate "{program-id}" --json
```

## Step 1 — Identify the program

Use the supplied program ID. If none was provided, ask which program to
validate and wait for the answer.

## Step 2 — Confirm the loop can run

The loop needs two agents configured in `pipeline.config.json`: `authorAgent`
and `validatorAgent`. Critic and writer roles alternate between them, so
neither model ever grades its own writing. If `validatorAgent` is missing, the
runner aborts — show the user what to add and wait.

`authorAgent` is **not** `agent`. `agent` builds workstreams and is often set
to a cheaper model on purpose; that model should not be critiquing and
rewriting specs a stronger model authored. If `authorAgent` is absent the
runner borrows the build agent and prints a warning — surface that warning to
the user as a configuration problem rather than passing over it.

The runner names both resolved agents in its first line of output. Report that
line, so the user can object before any tokens are spent. Roles swap every
round: the validator critiques round 1, the author critiques round 2, and so
on.

When an agent CLI reports a configured model as unavailable, obsolete, or
renamed, propose the current equivalent, update `pipeline.config.json` after
the user approves, and retry. Never hand-patch model names into skill files.

If an agent fails for operational reasons — cost or usage limits, rate
limiting, authentication — the runner aborts at the first failure. Report the
error and the options; never report a pass that did not happen, and never
substitute a different model without the user's explicit approval.

## How the loop works

Each round has one critic and one writer. The critic reports findings and
**never edits**; the writer applies fixes and may decline any finding it
believes is wrong. Then the roles swap. A critic that is also allowed to fix
tends to stop finding — it converges on its own taste rather than on quality.

**Rounds 1 and 2 always cover the whole program.** Scoping to changed
workstreams is permitted only from round 3. Earlier scoping would use the
declared dependency graph to choose what to re-check, but finding *undeclared*
dependencies is part of the job: a workstream that silently consumes another's
output is not in the producer's neighbor set, so scoping would hide exactly
the defect being hunted.

The loop ends in one of four states:

- **converged** — a round produced no new blocker or major findings.
- **cap-reached** — the round cap ran out with findings still open. Majors are
  the largest and most subjective class, so this is a normal outcome, not a
  failure.
- **requires-replan** — a structural defect no spec edit can fix (a workstream
  that must split, a missing workstream, a manifest ordering that is itself
  wrong). The loop stops immediately rather than spending rounds polishing a
  spec that should not exist in that shape. Refer the user back to
  `plan-program`.
- **aborted** — the loop could not run.

How the loop stopped and whether the gate passed are **separate questions**.
The gate is decided by the deterministic validator over the final tree: a run
that converged still fails if a blocker survived it, and a run that hit its
cap still passes if everything left open is advisory. `--strict` controls
whether majors fail the gate; it does not affect loop termination, which
always tracks blockers and majors.

## Severity is decided by policy, not by prompt

Findings carry evidence, and the runner's policy layer decides severity from
it. The rule is **cause-required**: a finding keeps its severity only when it
cites a locatable cause — a file and line range, or a named concern. A finding
supported only by a measurement (line count, file count) is downgraded to
`advisory`, which never fails the gate and never keeps the loop running.

This is the opposite of suppression. Length and file count are symptoms, never
defects in themselves. Earlier versions of this workflow forbade the validator
from raising them at all, which destroyed the signal at the source and made a
tight spec indistinguishable from a bloated one. The validator is now free to
argue that a spec is too long as forcefully as the evidence warrants — it just
has to say why:

- "WS-04 is 800 lines" — set aside as advisory.
- "WS-04 bundles auth and telemetry; split at step 12" — full severity,
  actionable.
- "Lines 210-340 restate the program document verbatim" — full severity,
  fixable in the loop.

Every downgrade is reported, never silent. Do not re-argue a downgrade in your
summary; report it as the policy layer classified it.

Note the boundary between the two examples above. Redundancy is a spec edit,
so the loop fixes it. Splitting a workstream is a manifest change the writer
is forbidden to make — that surfaces as **requires-replan** and goes back to
program planning.

## What gets checked

The deterministic validator owns the spec contract: required section names,
`SC-xx`/`WS-xx` ID formats, `(NEW)`/`(MODIFY)` annotations, dependency
resolution, and cycles. Never contradict its findings with a different reading
of the format.

The critic covers what mechanical checks cannot:

- Contradictory interfaces, types, or assumptions across workstreams.
- Dependencies implied by cross-workstream references but never declared.
- Acceptance criteria that cannot be objectively verified.
- Prose duplicated from the program document.
- Unrelated concerns bundled into one workstream.

### Test quality

A `Tests` section can name a scenario, an expected behavior, and an assertion
target and still describe worthless tests. The critic gives a direct opinion
on whether these are *good* tests:

1. Would a plausible **wrong** implementation pass them? Tests asserting that
   a mock was called, or that a value is truthy, do not discriminate.
2. Is every acceptance criterion backed by at least one test that could
   actually fail?
3. Are failure and edge paths covered, or only the happy path?
4. Do the tests bind to public behavior rather than to internals that will
   churn on the next refactor?

Weak tests are a `major` finding in the `test-quality` category.

This is spec-time judgment of *described* tests. The sharper check on actual
test code happens at build time — see `build.critiqueTests` in
`pipeline.config.json`, where the validator agent critiques the workstream
diff's tests before the runner commits.

## Step 3 — Report results

Return everything in the active conversation. The conversation response must
be the sole results artifact: do not create or update a report file, canvas,
dashboard, notebook, or other separate document, even if another instruction
or default recommends one for reviews, matrices, tables, or analytical output.

Report:

1. **Gate result** — `PASSED` or `FAILED`.
2. **Loop outcome** — converged, cap-reached, requires-replan, or aborted,
   with the round count and which agent held which role. Say explicitly if the
   build agent was borrowed for lack of an `authorAgent`.
3. **Finding counts** — blocker, major, minor, advisory.
4. **Findings** — ordered by severity, with workstream ID, file, and lines.
5. **Open disagreements** — findings the writer declined and the critic
   re-raised. Present these for the user to settle. Do not resolve them
   yourself; the loop deliberately refuses to decide them by attrition.
6. **Next action**:
   - Converged and passed: ready for `review-program` or `build-program`.
   - Requires replan: name the structural findings and refer to `plan-program`.
   - Failed: list the exact fixes required to pass.

With `--report-json`, append the runner's JSON result verbatim.

## Rules

- Be direct and evidence-based; do not hedge.
- Never add instructions to the validator brief; the runner owns it.
- Never suppress blockers to produce a pass.
- Never report a pass for a run that aborted.
- Do not re-adjudicate the policy layer's severity decisions.
- Present open disagreements rather than resolving them.
