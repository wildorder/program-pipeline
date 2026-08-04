---
name: build-program
description: Execute a program's dependency-ordered workstreams through the packaged build runner with validation, confirmation, independent verification, and status tracking. Use when a user asks to build, execute, or resume a planned program.
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

  The runner delivers each workstream prompt on stdin by default; set
  `"promptMode": "argument"` for agents that expect the prompt as the final
  positional argument. The `PROGRAM_PIPELINE_AGENT_COMMAND` environment
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
npm exec program-pipeline -- build "{program-id}" --dry-run
```

The plan lists workstreams in dependency order and marks the ones already
skipped as `complete`. Summarize total count, execution order, and any
skipped workstreams.

## Step 4 — Confirm and execute

Ask the user to confirm the plan. After confirmation, run:

```sh
npm exec program-pipeline -- build "{program-id}" --yes
```

To resume from a specific workstream regardless of status, add
`--start-from {ws-id}`. Otherwise the runner automatically skips workstreams
whose manifest status is already `complete`.

The runner performs, per workstream:

1. Mark the workstream `in_progress` in the manifest.
2. Invoke the configured agent with the workstream prompt.
3. Run every `verify` command itself; any failure triggers one focused
   recovery attempt (configurable via `build.maxRecoveryAttempts`).
4. Mark the workstream `complete` or `failed` and append structured JSON
   events to `build-logs/{program-id}-build-{timestamp}.jsonl`.

A failed workstream stops the build with a nonzero exit code.

## Step 5 — Report

Report from the runner output and the events log:

- Which workstreams completed, with attempt counts.
- Which workstream failed, the failing verify command, and the log path
  (`build-logs/{program-id}-{ws-id}.log`).
- Whether the build is resumable (`--start-from` or re-run to skip completed
  workstreams).
- Next step after a full pass: run the program review or update the as-built
  snapshot.
