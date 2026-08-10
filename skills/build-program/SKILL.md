---
name: build-program
description: Execute a program's dependency-ordered workstreams through the packaged build runner with validation, independent verification, per-workstream commits, and status tracking. Use when a user asks to build, execute, or resume a planned program.
argument-hint: "[program-id]"
disable-model-invocation: true
---

# Build Program

Execute a program's workstreams through the packaged build runner.

## Step 1 — Identify the program

Use the supplied program ID. If none was provided, ask which program to build and wait for the answer.

## Step 2 — Check the pipeline configuration

Read `pipeline.config.json` in the project root. The runner requires:

- **`agent`** — the agent CLI that implements each workstream, for example:

  ```json
  "agent": { "command": "claude", "args": ["-p"], "promptMode": "stdin" }
  ```

  The runner delivers each workstream prompt on stdin by default — prefer
  stdin whenever the agent CLI supports it. Use `"promptMode": "argument"`
  only when the agent requires a positional prompt; argument mode spawns the
  command directly without a shell, so on Windows it cannot launch `.cmd`
  shims — the command must be a real executable. If prompt delivery ever
  appears broken (agents acting as if they received no instructions), check
  this setting first. The `PROGRAM_PIPELINE_AGENT_COMMAND` environment
  variable works as a fallback when no `agent` block exists.

- **`verify`** — the commands the runner executes itself after every
  workstream, for example:

  ```json
  "verify": { "build": "npm run build", "test": "npm test" }
  ```

  Verification is independent: a workstream passes only when every verify
  command exits successfully, regardless of what the agent reports.

If either block is missing, show the user what to add and wait for approval
before editing `pipeline.config.json`.

Two optional keys change how this skill behaves:

- **`requireApprovalBeforeBuild`** (default `false` for projects initialized
  by this package) — the only approval gate. See Step 4.
- **`build.commit`** (default `true`) — the runner commits each workstream
  itself after verification passes. See Step 4.
- **`build.critiqueTests`** (default `false`) — after verification passes and
  before the commit, hand the workstream's diff to the `validatorAgent` and
  ask whether the tests would actually catch a wrong implementation. See
  Step 4.

**Model transparency:** the `agent` block is the single source of truth for
which agent and model build every workstream. State it verbatim to the user
in this step — for example "each workstream will be built by
`claude -p --model sonnet`" — and note that changing it means editing the
`agent` block. The runner also prints the resolved agent line in its dry-run
and approval output; never let a build start without the user having seen
it.

If a build fails because the agent CLI rejects the configured model as
unavailable, obsolete, or renamed, propose the current equivalent, update
the `agent` block in `pipeline.config.json` after the user approves, and
resume the build — never work around it by invoking the agent manually.

If a `build-product.ps1` exists in the project root, it is a legacy runner
from a previous package version — ignore it, never invoke or update it, and
suggest deleting it.

## Step 3 — Show the execution plan

Run a dry run and present the output:

```sh
npx --yes @wildorder/program-pipeline build "{program-id}" --dry-run
```

The plan lists workstreams in dependency order and marks the ones already
skipped as `complete`. Summarize total count, execution order, and any
skipped workstreams.

## Step 4 — Execute

Invoking this workflow *is* the instruction to build. Do not ask the user to
confirm the plan — report it (Step 3) and start the build in the same turn:

```sh
npx --yes @wildorder/program-pipeline build "{program-id}" --yes
```

The single exception: when `requireApprovalBeforeBuild` is `true` in
`pipeline.config.json`, the user has explicitly asked to approve every build —
present the plan and wait. Otherwise stopping to ask is friction the user has
already opted out of. Ask mid-build only about a genuine blocker (a missing
config block, an ambiguous program ID, a failure needing a decision).

To resume from a specific workstream regardless of status, add
`--start-from {ws-id}`. Otherwise the runner automatically skips workstreams
whose manifest status is already `complete`.

The runner performs, per workstream:

1. Mark the workstream `in_progress` in the manifest.
2. Invoke the configured agent with the workstream prompt.
3. Run every `verify` command itself; a failed verify command is retried
   in place first (configurable via `build.verifyRetries`, default 1, which
   absorbs flaky tests), and a persistent failure triggers one focused
   recovery attempt (configurable via `build.maxRecoveryAttempts`).
4. Mark the workstream `complete` or `failed` and append structured JSON
   events to `build-logs/{program-id}-build-{timestamp}.jsonl`.
5. Commit the working tree as `build({program-id}): {ws-id} {name}`.

A failed workstream stops the build with a nonzero exit code.

### Test critique

Verification proves the implementation and its tests agree — but the same
agent wrote both, so a green suite is the two halves of one opinion. With
`build.critiqueTests` enabled, the runner hands the diff and the spec to the
`validatorAgent`, which wrote neither, and asks whether a plausible wrong
implementation would pass, whether every acceptance criterion has a test that
could fail, whether failure paths are reached, and whether any test was
weakened or deleted to make the suite green.

This **annotates and never blocks**. A commit that passed independent
verification still lands; the findings go to the events log
(`test-critique`) and the build result, where you report them. A model
judgment is not a strong enough signal to stall an unattended build, and
blocking would need a rewrite-and-recheck loop that may never settle. If you
want a failing critique to stop the build, that is a change to request
explicitly — it is not the current behavior.

It requires a `validatorAgent`; without one the runner logs
`test-critique-skipped` and continues.

### Commits

The runner owns commits — workstream agents are told never to commit. One
commit per workstream, written only after independent verification passes, so
every runner-authored commit is green. Set `build.commit` to `false`, or pass
`--no-commit`, to build without committing.

Because those commits must never absorb unrelated work, the runner refuses to
start when the working tree is dirty. If a build aborts for that reason,
report the listed paths and offer to commit or stash them — do not pass
`--no-commit` to route around it unless the user asks. The one dirty tree the
runner does accept is the uncommitted work its own previous failed run left
behind, so resuming after a failure works untouched.

A commit that git itself refuses (a hook, a missing `user.email`) is reported
as `commit failed` and leaves the verified changes in the working tree; the
workstream still counts as complete.

The runner also owns the program-level status in the manifest: `planning` →
`in_progress` when execution starts, then `complete` when every workstream
is complete or `failed` when the build stops on a failure (a successful
resume flips it back to `complete`). Do not edit program or workstream
statuses by hand.

Two failure modes resolve themselves on re-run — recognize them instead of
debugging the workstream:

- **Agent environment failure** (the reason names it): the agent CLI died
  at startup — usually a usage/rate limit ("session limit" in the output
  tail) or a credential problem. The workstream was not attempted; re-run
  the build once the agent CLI is healthy and it resumes from that
  workstream.
- **No-op with prior work**: when a previous attempt already landed the
  implementation, a re-run agent that changes nothing proceeds to
  verification automatically (the runner compares against the tree
  fingerprint from the workstream's first attempt, persisted in
  `build-logs/{program-id}-baselines.json`) — already-implemented work
  verifies and completes without manual manifest edits.

## Step 5 — Report

Report from the runner output and the events log:

- Which workstreams completed, with attempt counts and commit SHAs.
- Which workstream failed, the failing verify command, and the log path
  (`build-logs/{program-id}-{ws-id}.log`).
- Any test-critique findings, grouped by workstream. These are advisory and
  did not block the commit; present them so the user can decide what to fix.
- Whether the build is resumable (`--start-from` or re-run to skip completed
  workstreams).
- Next step after a full pass: run the program review or update the as-built
  snapshot.
