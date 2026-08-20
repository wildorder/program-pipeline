# Program Memory — design pass

Status: proposal (design guidance, not yet scheduled)
Date: 2026-08-19

## The problem, stated precisely

The pipeline's core bet — clean agent per unit of work, package-composed
briefs, fail-closed protocol checks — is right. What it lacks is not
structure; it is **continuity of judgment**. Nearly every piece of judgment
the pipeline produces is written for exactly one immediate consumer and then
destroyed:

- The convergence loop's findings ledger (`seen`, `unresolved`,
  `disagreements`) is an in-memory `Map` inside one `validateLoop` call.
  The next `converge` invocation starts blank, so the critic re-litigates
  questions the writer already answered.
- A writer's *decline with reason* — the closest thing the system has to an
  adjudication — survives only until the process exits. Open disagreements
  are returned to `run-program.ts` and dropped (`record()` keeps only
  `{stage, result, reason, commit}`).
- A PASSED plan-audit persists nothing: `criterionAssessments`,
  `modeAssessment`, and `classAnalyses` — real evidence of what was verified
  and how — are recomputed from scratch on every replan cycle.
- Build failure diagnosis lives in local variables. A resumed
  `run --from build` hands the agent the plain first-attempt prompt; the
  previous run's failure reason and output tail are gone. The manifest
  records `status: "failed"` with no reason.
- The replan report — the one artifact that *does* carry causal history —
  exists only on the error path, is deleted on convergence success
  (`rm`, no archive), and is read by exactly one consumer. Each new
  automatic-replan cycle writes a fresh report whose `attemptHistory`
  starts empty, so cycle 3 cannot see cycle 1's failures.
- Severity downgrades, safe checkpoint assessments, applied criteria
  patches, resolution-proof contents, test critiques, author summaries,
  and execution-fit assessments are all produced, parsed, and discarded.
- `build-logs/` is gitignored, so every `criticLogs` path stored in a
  *committed* replan report dangles on any other machine or in CI.

The observed symptom follows directly: a run stalls when validators raise
findings, the loop hits `cap-reached` at 2–3 rounds, the human replans
manually, and the next run **re-derives everything and re-raises the same
or adjacent findings**, because the system has no concept of a settled
question. Separation of stages is not the flaw. Amnesia between them is.

## The concept

**Program memory** is one canonical, schema-validated, committed store per
program that records what happened, what was decided, and why — and that
every stage both reads a *projection* of and writes *events* into, always
through the runner (never by an agent directly, preserving the no-seam
principle).

It is two layers:

1. **Journal** — append-only events. Facts, never mutated:
   "critic raised finding `f3a9…` at major in run 7 round 2",
   "writer declined `f3a9…`: <reason>", "human approved criteria hash H",
   "WS-04 build attempt 2 failed: <verify command> exited 1, tail: …",
   "replan 2026-08-17 superseded WS-03 → WS-11/WS-12".
2. **State view** — the current answer to "where are we", derived from the
   journal by a deterministic reducer in the package (rebuildable at any
   time, like every other deterministic responsibility the runner owns).
   This is the layer that gets projected into briefs.

Suggested layout (consumer project):

```
docs/programs/<id>-memory.jsonl    # journal, append-only, committed
docs/programs/<id>-memory.json     # derived state view, committed
```

Append-only JSONL merges cleanly in git and survives machines, CI, and
sessions. The state view is small by construction; the journal is never
placed in a prompt wholesale.

## The entities

### Findings with a lifecycle

Finding fingerprints already exist (`sha256(category|ws|subject)` in
`findings.ts`) and are deliberately stable across severity/message/line
changes — identity without persistence. Give the identity a home:

```
findings: {
  "<fingerprint>": {
    finding,                 // latest version (fix gap: last-raised wins,
                             // history preserves earlier versions)
    status: "open" | "fix-applied" | "resolved" | "declined"
          | "waived" | "superseded",
    firstRaised: {runId, stage, round},
    exchanges: [{runId, round, raisedRationale, writerDecision,
                 declineRationale?}],
    humanDecision?: {kind: "waived"|"upheld", rationale, at, scopeHash}
  }
}
```

**Model output is context, never precedent.** A writer's decline is
recorded as a *position with rationale*, not a settlement. The critic
brief shows the prior exchange for each previously-raised fingerprint and
requires engagement: the critic may re-raise freely, but must address why
the stated decline rationale is insufficient. A re-raise that ignores the
prior rationale is treated the way the severity policy treats evidence-free
findings — set aside, never forbidden. Nothing a model concluded is
binding; a critic with a genuinely new argument wins on the argument.
Today the critic gets prior-round subjects only, within one process; with
the ledger it argues with full information across runs, which is what
removes the zero-information repeat rounds that force manual replans.

### Decisions: humans only, durable but revocable

Only human judgments become decision records: criteria approval, finding
waivers/upholds via `decide`, execution-mode choice. Each carries actor,
rationale, timestamp, and an input-hash scope so it lapses automatically
when the content it judged changes (the criteria-approval hash mechanism,
generalized). Durable means "survives the process and the machine," never
"cannot be revisited" — any decision can be overturned by a later `decide`.
Severity downgrades, writer declines, and replan supersessions are journal
*events* (visible history), not decisions.

**Repeated stalemate is a signal, not a stored verdict.** When the same
fingerprint completes a raise → decline cycle with substantively unchanged
rationale across two separate runs, the runner stops re-running the
argument: it writes a `pending-decision` into memory and exits with a
distinct code. The models argued twice with full information and did not
move — that is fact-shaped, and it is the trigger for the human gate. The
human answers with a command, not a manual replan:

```
program-pipeline decide <id> --finding f3a9 --waive  --reason "..."
program-pipeline decide <id> --finding f3a9 --uphold           # forces fix
```

That converts "validators are throwing a fit and I have to hand-replan"
into the same shape as the criteria gate: a batched, resumable human
decision presented with both positions and their rationale. This is the
second human gate the pipeline actually needs — and it is asked for once,
with the full exchange in front of the owner, instead of reverse-engineered
from a stalled run.

### Attempt history per unit of work

Keyed by (workstream | stage | replan-cycle): outcome, reason, verify
failure, bounded output excerpt. Consumers:

- Build recovery prompts survive process death — a resumed run's agent is
  told what failed last time and why (today: lost entirely).
- Replan cycle N sees cycles 1..N−1 (today: each report starts empty).
- The author's cycle/unmet/execution-fit diagnoses — the three
  REQUIRES_REPLAN exits that currently write **no** replan report and thus
  can never auto-replan — become durable events with full detail instead of
  a prose `reason` string plus a gitignored JSONL line.

Because logs stay local, memory events carry **bounded excerpts** (the
evidence that mattered), not paths into `build-logs/`. Committed artifacts
must never point at gitignored files.

### Narrative

A bounded prose section in the state view — "what has happened on this
program and where it stands" — maintained deterministically where possible
(from events) and compacted when it grows. This is what makes any fresh
session, human or agent, able to answer "wtf is happening" in one read.

## Who reads and writes what

| Stage | Reads (projection) | Writes (events) |
| --- | --- | --- |
| plan-audit | prior assessments, decisions, replan supersessions | criterion assessments **including on PASS**, mode assessment, class analyses |
| author | per-WS attempt history, open findings touching its scope | author summaries, execution-fit, cycle/unmet diagnoses |
| converge | finding ledger + exchange history, prior round provenance, human + pending decisions | every finding transition, writer verdicts (and their logs — writer output is currently never logged), resolution proofs, checkpoint assessments incl. safe ones, downgrades, criteria patches |
| criteria | pending decisions | approval events |
| build | attempt history for the workstream (cross-run recovery context) | failure reasons, test critiques, workstream summaries, commit refs |
| as-built | narrative, waived findings, test critiques, attempt history | its own summary |
| replan | full projection (parity with what the `/plan-program` skill demands — today the automatic replanner gets a strict subset) | supersession map (old WS → new WS), the replanner's own rationale (currently discarded) |

Two invariants:

1. **Agents never write memory.** The runner appends events from parsed
   reply contracts, exactly as it already records summaries verbatim and
   owns commits. No agent grades or narrates its own output into the
   record.
2. **Push the constraints, point at the rest.** Memory content splits into
   two kinds with opposite requirements. *Constraints* — prior exchanges on
   in-scope findings, human decisions, pending decisions, this unit's last
   failure — are pushed into the brief, because an agent never retrieves
   what it does not know it needs, and a critic that never sees the prior
   exchange repeats it verbatim; pushed context is
   also recorded in the composed brief, so behavior stays reproducible and
   no agent can narrow its own gate by declining to fetch. This slice is
   small by nature (conclusions plus rationale, not transcripts).
   *Evidence* — a finding's full history, prior attempt excerpts, audit
   assessments for a specific criterion — is pulled on demand: the brief
   names the committed state-view path and a query subcommand
   (`program-pipeline memory <id> --finding <fp> | --attempts <ws> |
   --decisions`), and the agent — a CLI agent with file and shell access —
   fetches what its actual task turns out to need. Retrieval needs no MCP
   server and stays provider-neutral; an MCP surface, if ever wanted, is a
   thin wrapper over the same query API. The journal is never placed in a
   prompt; the state view stays small because it holds current status per
   entity (one entry per distinct finding fingerprint regardless of how
   many runs re-raised it), with attempts capped and the narrative
   compacted.

## What this absorbs and retires

- **The replan report becomes a projection**, not a store. Everything it
  preserves today (findings, class analyses, checkpoint assessments,
  attempt history) lives in memory; `-replan.json` can remain as a
  rendered handoff view for the skill, generated from memory. Convergence
  success stops *deleting* history — it writes a `converged` event; the
  causal record of why a replan happened survives its resolution.
- **`-convergence.json` stays** (it is a content-addressed gate receipt, a
  different job), but its `waivedFindings` fingerprints become resolvable —
  today they are opaque 16-hex IDs whose meaning died with the process.
- **`baselines.json` / `uncommitted.json`** fold into attempt history.
- The events JSONL in `build-logs/` remains as raw telemetry; memory is
  the curated, committed subset.

## Sequencing (each phase ships alone)

1. **`src/program-memory.ts`** — zod + JSON Schema types, append/reduce/
   project API, atomic writes, `schemaVersion`, and the `memory <id>`
   query subcommand (the pull affordance). Wire converge to persist
   the finding ledger and exchange history, and to **seed `seen` /
   `disagreements` from memory** at loop start. Inject the prior-exchange
   section into the critic brief. This alone attacks the manual-replan loop.
2. **Attempt history**: build failures (cross-run recovery prompts),
   replan cycles, author's three report-less REQUIRES_REPLAN exits.
3. **`decide` command + pending-decision outcome** for cap-reached
   disagreements; batched like criteria.
4. **Plan-audit persistence on PASS**; replanner projection parity with
   the skill path.
5. **Narrative + as-built grounding** (Known Limitations written from
   waived findings, test critiques, and attempt history instead of a blind
   codebase scan).
6. Retire replan-report-as-store; render it from memory.

## Risks

1. **False settlement — largely designed out.** Model conclusions are
   context, never precedent: a decline is a position the next critic must
   engage, not a ruling that suppresses re-raising. The residual risk sits
   in human decisions, which is where it belongs — and those are
   scope-hashed (lapse on content change) and revocable via `decide`.
2. **Chilling the critic — reduced to an engagement rule.** No "settled,
   don't re-raise" instruction exists; the critic is only required to
   address the prior decline rationale when repeating a fingerprint, the
   same cite-your-cause discipline as the severity policy. Novel findings
   are untouched; monitor fresh-finding counts anyway.
3. **Staleness across replans.** Supersession must remap or lapse memory
   entries referencing replaced workstreams — orphaned constraints if it
   does neither, total memory reset if it lapses too aggressively.
4. **Receipt interaction.** Decide explicitly whether adjudications/waivers
   are semantic inputs to the convergence-receipt hash; if not, an
   overturned waiver leaves a valid receipt behind.
5. **Committed state.** Derived JSON view is regenerable, never
   hand-merged (JSONL journal merges cleanly). Attempt-history excerpts
   need sanitation — agent output tails can carry env values or tokens
   that gitignored logs never exposed.
6. **Reducer as second brain.** Keep the reducer to dumb status
   transitions; stages consume the view, never reimplement its semantics.
7. **Unvalidated premise.** Re-litigation as the dominant blocker is
   inferred, not measured. Before building: grep recent converge critic
   logs and count repeated fingerprints across runs. High repeat rate →
   phase 1 pays; low → the blocker is protocol strictness or plan quality,
   and this design should wait.
8. **Maintenance cost.** Phase 1 is deliberately one module + two wiring
   points; every later phase is optional if phase 1 alone restores
   throughput.

## Non-goals

- Not an event-sourcing framework. One module, one reducer, two files.
- Not a transcript archive. Bounded excerpts only; raw logs stay local.
- Not a change to the agent-isolation model. Memory is what the *runner*
  knows; agents still get clean, composed, minimal briefs — now including
  the one category of context that was never safe to drop.
