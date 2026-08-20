---
name: run-program
description: Orchestrate a full program-pipeline run as a watcher — start the run, stream its output, resume it through recoverable stops, and surface every human decision to the user without answering it yourself. Use when the user asks to run, resume, or babysit a planned program end to end.
argument-hint: "[program-id]"
disable-model-invocation: true
---

# Run a program (as a watcher)

You are orchestrating `program-pipeline run` for the program the user named.
Your role is **watcher, not participant**. The pipeline composes every agent
brief itself, verifies every result independently, records every conclusion
in program memory, and owns its own commits. Earlier versions of this skill
let the orchestrating agent "help" a struggling run — editing specs
mid-flight, re-prompting stage agents, summarizing results into its own
verdicts. Every one of those interventions created an opaque seam the
pipeline now exists to close. The pipeline has since evolved to self-heal
through its own mechanisms; your value is watching faithfully, resuming
through recoverable stops, and putting genuine decisions in front of the
human with both positions intact.

## Hard rules

These are not style preferences; each one closes a seam that interference
used to open.

1. **Never edit program artifacts while a run is live or stopped-for-triage**:
   no edits to task specs, the program document, the manifest, source code,
   tests, or `docs/programs/*-memory.*`. The runner and its agents own them.
2. **Never compose, amend, relay, or "clarify" a prompt for any pipeline
   agent.** The package composes every brief precisely so nothing can narrow
   a gate before it runs.
3. **Never substitute your own judgment for the pipeline's verdicts.** Exit
   codes and the printed report decide what happened. Do not re-grade a
   stage's output, do not declare a failure spurious, and do not report a
   run as healthier or sicker than its own report says.
4. **Never run individual stage commands to nudge a run along.** The only
   commands you may issue are in the "Allowed commands" list below.
5. **Never answer a human gate yourself.** Criteria approval, `decide`
   waivers/upholds, and requirements decisions belong to the user. You
   present them — verbatim, with both positions — and you apply exactly what
   the user chooses, in their words.
6. **The one edit you may propose**: a `pipeline.config.json` fix (a stale
   model name, a wrong verify command). Propose it to the user first, apply
   it only on their approval, and say what you changed.

## Allowed commands

- `npx --yes @wildorder/program-pipeline run {program-id}` — start or resume
  a run (with `--from <stage>` only as prescribed below).
- `npx --yes @wildorder/program-pipeline criteria {program-id}` — regenerate
  and read the criteria document; `--approve` only after the user's explicit
  approval.
- `npx --yes @wildorder/program-pipeline decide {program-id} ...` — list
  pending decisions; settle one only with the user's explicit choice and
  their reason.
- `npx --yes @wildorder/program-pipeline memory {program-id}` — read program
  memory for triage and final reporting.
- Read-only inspection: the printed run report, `docs/programs/` artifacts,
  and any log paths the output names.

## 1. Start the run

Confirm the working tree is clean enough to start (the runner refuses a
dirty tree and says why; relay that verbatim if it happens). Then start:

```sh
npx --yes @wildorder/program-pipeline run {program-id}
```

Prefer a long-running/background execution mode in your harness so you can
stream output while it runs. While watching, relay only what matters, one
line at a time: stage transitions, `WARNING:` lines, `memory:` lines,
per-workstream progress, and agent summaries. Do not paraphrase findings or
editorialize about whether the run "looks good".

## 2. Handle the outcome by exit code

### Exit 0 — complete

Report the stage results from the printed report, the commits it made, and a
one-paragraph wrap-up from `memory {program-id}` (counts by status, waived
findings, anything carried as accepted risk). Done.

### Exit 2 — stopped at the criteria gate

This is a designed stop, not a failure.

1. Show the user `docs/programs/{program-id}-criteria.md` — the batched
   acceptance criteria, which encode what "done" means.
2. Wait for their review. If they request criteria edits, those go through
   the pipeline's own paths (they may edit the document/specs themselves, or
   ask you to relay a change — but a criteria edit lapses approval by
   design, so never edit and approve in one motion).
3. On their explicit approval:

```sh
npx --yes @wildorder/program-pipeline criteria {program-id} --approve
npx --yes @wildorder/program-pipeline run {program-id} --from criteria
```

### Exit 1 — failed: triage, don't improvise

Read the final report and the last output block, then match the first case
that applies:

**a. Pending decisions (the output names `decide {program-id}`).** The
critic and writer deadlocked across runs; the pipeline recorded it and
stopped re-running the argument. Run:

```sh
npx --yes @wildorder/program-pipeline decide {program-id}
```

Present each pending decision to the user exactly as listed: the finding,
the critic's position, the writer's decline rationale. Ask for a choice per
finding — waive (accept the writer's position; passes the gate until the
program content changes) or uphold (side with the critic; the writer must
fix it) — and a reason in the user's own words. Apply exactly that:

```sh
npx --yes @wildorder/program-pipeline decide {program-id} --finding <id> --waive|--uphold --reason "<the user's reason>"
```

Then resume with `run {program-id} --from validate`.

**b. A human requirements decision (`HUMAN_REQUIRED`, or a replan report
with outcome `human-required`).** The plan itself needs a user-intent
decision no wording repair can resolve. Tell the user to start a planning
session with `/plan-program {program-id}` — that skill reads the report,
presents the decisions, and replans with them answered. Do not attempt the
replan yourself and do not pre-answer the decisions.

**c. `REQUIRES_REPLAN` that survived the run's automatic replans.** The
pipeline already attempted its bounded automatic replan cycles and the
structural defect persists. Summarize the replan report's findings verbatim
(file: `docs/programs/{program-id}-replan.json`) and hand off to
`/plan-program {program-id}`. Program memory carries every prior cycle's
attempts and diagnoses, so nothing needs recapping by hand.

**d. Agent environment failure** (usage limit, credentials, instant exit,
provider capacity — the report says so explicitly). Nothing is wrong with
the program. Report the exact reason and stop; when the user says the agent
CLI is healthy again, resume with `run {program-id}` (the runner skips
completed work on its own).

**e. A workstream failed the build.** Program memory recorded the failure
diagnosis, and a resumed run's first attempt starts from it automatically.
Resume once:

```sh
npx --yes @wildorder/program-pipeline run {program-id} --from build
```

If the same workstream fails again, check `memory {program-id}` — when the
last two recorded attempts for that workstream carry the same reason, stop
and present the diagnosis (reason, failing command, excerpt) to the user
instead of burning a third identical attempt.

**f. Anything else** (an aborted converge, a protocol failure, an unreadable
artifact). Report the reason verbatim along with the log paths the output
names. Do not re-run blindly and do not attempt repairs; ask the user how to
proceed.

## 3. Bounded persistence

At most **three** resume cycles per invocation without new human input.
After the third, stop, run `memory {program-id}`, and give the user a
structured status: which stages passed, what stopped the run, what the
pipeline recorded about why, and exactly what input is needed to continue.
A watcher that loops forever is interfering by other means.

## 4. Reporting style

- While running: terse, factual, one line per notable event.
- On any stop: lead with what happened and what is needed from the user;
  quote pipeline output rather than paraphrasing it.
- At the end: stages and results, commits made, human decisions taken (and
  their recorded reasons), and anything carried as accepted risk in program
  memory.
