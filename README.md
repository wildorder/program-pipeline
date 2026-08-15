# @wildorder/program-pipeline

A provider-neutral TypeScript CLI and portable Agent Skills package for planning,
validating, building, and documenting engineering programs.

## Get started

```sh
# 1. One-step setup: adds the devDependency and installs the workflow skills.
#    In a terminal it asks which agent tools to install for, pre-selecting the
#    ones it found on this machine; everywhere else it takes those defaults.
npx --yes @wildorder/program-pipeline setup

# 2. In your agent, run the guided setup
#    /init-project
```

Skills install **per machine** by default (`~/.claude/skills` and friends), so
one update covers every repository you work in. Pass `--scope project` to put
them in the repo instead, where they are committed and pinned per project.

Works in an empty directory — no `npm init` first. When the target has no
`package.json`, `setup` writes a minimal private one so the pipeline can be
pinned as a devDependency.

`/init-project` interviews you for the project details, runs the deterministic
`init` scaffolding under the hood, and finishes by pointing you at
`/plan-program` to plan your first program. From there everything is a CLI
command you run from a terminal or CI, not from inside a chat session:

```sh
npx --yes @wildorder/program-pipeline author phase-1
npx --yes @wildorder/program-pipeline converge phase-1
npx --yes @wildorder/program-pipeline review phase-1
npx --yes @wildorder/program-pipeline criteria phase-1 --approve
npx --yes @wildorder/program-pipeline build phase-1
npx --yes @wildorder/program-pipeline as-built phase-1
```

## Install

Published on the public npm registry as
[`@wildorder/program-pipeline`](https://www.npmjs.com/package/@wildorder/program-pipeline) —
no tokens, private registry configuration, or repository credentials required:

```sh
npm install --save-dev @wildorder/program-pipeline
```

Run the local executable with `npx`:

```sh
npx --yes @wildorder/program-pipeline --help
```

Always spell the full scoped package name. The executable is named
`program-pipeline`, but `npx program-pipeline` (or `npm exec program-pipeline`)
resolves only from a working directory that already has the package installed;
anywhere else npm looks up the unscoped name on the registry and fails with
`404 Not Found`. Every command below works from any directory and prefers a
local install when one is present.

## CLI

### `setup`

One-step onboarding for a project: adds `@wildorder/program-pipeline` as a
devDependency and then runs the skills installer. Accepts every option `install`
does (`--targets`, `--scope`, `--root`, `--force`, `--yes`, `--prune`).

A brand-new project needs no `npm init` first. When the directory has no
`package.json`, `setup` writes a minimal placeholder — `name` derived from the
directory, `version` `0.0.0`, `private` `true` — and then installs into it.
Deliberately not `npm init --yes`: that writes a stub `test` script that fails
by design, which `init` would pick up as a verify command and fail every build
on. Two directories are left alone:

- one that already declares another ecosystem (`pyproject.toml`, `go.mod`,
  `Cargo.toml`, `*.csproj`, and similar) — no `package.json` is invented for a
  non-Node project;
- any directory, when `--no-package-json` is passed.

In both cases `setup` reports the skip and still installs the workflow skills;
run the CLI through `npx @wildorder/program-pipeline` there instead of a pinned
local install.

The devDependency is added with the project's own package manager, detected
from the `packageManager` field in `package.json` and then from the lockfile
(`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`, `package-lock.json`),
walking up from `--cwd` so workspace packages resolve to the repo root's
manager. Falls back to npm; override detection with `--pm <npm|pnpm|yarn|bun>`.
At a pnpm workspace root the dependency is added with `pnpm add -D -w`.

Re-running `setup` is also the update path: it bumps the dependency to the
latest published version and refreshes all unmodified package-generated
skills to match, leaving hand-edited skills untouched (reported as
conflicts). At project scope, commit the resulting diff. Teams pinned to an
older version should instead use `npm update` plus
`npx --yes @wildorder/program-pipeline install`.

```sh
npx --yes @wildorder/program-pipeline setup
npx --yes @wildorder/program-pipeline setup --targets claude
npx --yes @wildorder/program-pipeline setup --scope project
npx --yes @wildorder/program-pipeline setup --pm pnpm
npx --yes @wildorder/program-pipeline setup --no-package-json
```

### `init`

Create the standard program-pipeline structure in a new project, or adopt an
existing one. Existing files are never overwritten.

```sh
npx --yes @wildorder/program-pipeline init --cwd .
npx --yes @wildorder/program-pipeline init --cwd . --name "Acme Dashboard" --stack "TypeScript/Node" --description "Operations dashboards for growing teams."
```

All identity flags are optional: `--name` and `--description` default to the
`package.json` values, and `--stack` defaults to a summary detected from the
repository (package manifests, tsconfig, pyproject, go.mod, Cargo.toml). The
dependency table in `AGENTS.md` is prefilled from `package.json`.

Brownfield behavior: when `AGENTS.md` already exists, `init` merges rather
than skips — it adds or refreshes only the marked `BEGIN/END UNIVERSAL`
directives block and leaves every other line untouched. Existing markdown
documentation (root-level `*.md` and `docs/**`) is recorded as `contextDocs`
in `pipeline.config.json`, which the planning and validation workflows read.

The universal directives block is resolved in this order: an explicit
`--directives <path>` override, then
`~/.program-pipeline/universal-directives.md`, then the directives template
packaged with this package.

### `install`

Install the packaged workflow skills for the agent tools you use.

```sh
npx --yes @wildorder/program-pipeline install
npx --yes @wildorder/program-pipeline install --targets "cursor,claude"
npx --yes @wildorder/program-pipeline install --scope project --cwd .
```

#### Choosing targets

Run in a terminal with no `--targets`, and `install` asks:

```text
Where should the workflow skills go?

 ❯ ◉ Claude Code  ~/.claude/skills
   ◉ Cursor       ~/.cursor/skills
   ◯ Codex        ~/.agents/skills    (not detected)
   ◯ Gemini CLI   ~/.gemini/skills    (not detected)
   ◯ OpenClaw     ~/.openclaw/skills  (not detected)

   ↑↓ move · space toggle · a all · enter confirm · esc cancel
```

Tools whose config directory exists are pre-selected; the rest stay visible so
you can opt in. A second screen asks for the scope, and your answer is saved to
`~/.program-pipeline/install.json` so later runs — including npm lifecycle
hooks — reuse it without asking again.

The wizard is skipped whenever a human is not driving: no TTY on both ends,
`CI` set in the environment, `--yes`, or an explicit `--targets`. In those cases
the same defaults apply silently and the chosen targets are printed. This
matters because the packaged skills and `prepare` hooks invoke this CLI
themselves — a blocking prompt there would hang.

#### Scope

| `--scope` | Destination | Use when |
| --- | --- | --- |
| `user` (default) | `~/.claude/skills/…` | One update per machine covers every repository. |
| `project` | `.claude/skills/…` under `--cwd` | The repo should carry a pinned copy for the whole team. |
| `both` | Both of the above | Migrating, or a repo that pins while you also work elsewhere. |

Project-scope skills shadow user-scope ones in most harnesses, so a repo
carrying an old project-scope install keeps running those copies after you move
to user scope. `--prune` removes the project copies whose content hash proves
they are unmodified package output; edited files are always kept and reported.
Interactive runs offer this automatically when stale copies are found.

#### Where each target reads from

| Target | User scope | Project scope |
| --- | --- | --- |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Cursor | `~/.cursor/skills` | `.cursor/skills` |
| Codex | `~/.agents/skills` | `.agents/skills` |
| Gemini CLI | `~/.gemini/skills` | `.gemini/skills` |
| OpenClaw | `~/.openclaw/skills` | `skills` |

`.agents/skills` is the cross-tool shared directory — some other agents (Cursor
among them) also read it, so targeting `codex` alongside `cursor` can surface
the same skill twice in tools that scan both locations.

#### Overriding a root

Each target's root is resolved in this order, and `doctor` prints the result:

1. `--root <target>=<path>` (repeatable)
2. `PROGRAM_PIPELINE_SKILLS_ROOT_<TARGET>` in the environment
3. The tool's own config-home variable, where one is documented —
   `CLAUDE_CONFIG_DIR`, `CODEX_HOME`
4. The default under your home directory

`CODEX_HOME` moves where Codex is *detected* without moving where skills are
*written*, because Codex reads the shared `.agents` tree rather than its own
config directory. Layers 1 and 2 exist so an undocumented or unusual layout is
fixable without waiting on a release.

#### Safety

Before writing, the installer scans matching project and user-level command and
skill directories for every targeted agent. Alternate definitions produce
detailed warnings but remain untouched. A user-authored or edited file at an
installation destination is a blocking conflict: the entire installation aborts
before writing anything, and nothing is pruned. Identical skills are skipped and
unmodified package-generated skills update safely. Use `--force` only when you
explicitly want packaged content to replace destination conflicts.

### `author`

Write every workstream spec for a program, one clean agent per workstream.

```sh
npx --yes @wildorder/program-pipeline author phase-1 --cwd . --dry-run
npx --yes @wildorder/program-pipeline author phase-1 --cwd .
npx --yes @wildorder/program-pipeline author phase-1 --cwd . --only WS-03,WS-07 --force
```

Authoring every spec in one session degrades the later ones: workstream eight
gets written in a context already carrying one through seven. A fresh agent
per workstream fixes that — but a flat fan-out replaces it with a worse
problem, because two dependent workstreams authored in isolation disagree
about the interface between them and nobody finds out until build.

So the fan-out walks **dependency levels**. Independent workstreams author
concurrently; a workstream that depends on another waits and is given that
one's finished spec. The edge is directional, so there is nothing to
negotiate: the producer decided, and the consumer conforms.

**Discovery is separate from conformance.** Every brief carries the full
roster — the id, name, and scope of every workstream in the program —
because an author that cannot see a workstream exists does not merely omit
the dependency, it reimplements that workstream's work. Knowing a node exists
costs a few lines; conforming to it costs its whole spec, and is paid only
for declared dependencies. The brief says so explicitly: the roster tells an
author what exists, not how it works, and an author that needs to conform is
told to ask rather than guess.

Each author returns a declaration alongside its summary:

| Field | Meaning | What the runner does |
| --- | --- | --- |
| `dependencies` | every workstream this spec consumes output from | merged into the manifest |
| `needs` | a dependency whose spec it did not have | re-authored with that spec in hand |
| `unmet` | a requirement no workstream provides | a coverage gap: back to planning |

**Discovered edges are reconciled, not raised as findings.** A finding is a
problem someone must resolve; a discovered dependency is not a problem. If a
spec consumes another workstream's output then the edge exists and the
manifest is simply out of date — correcting it is transcription, and routing
transcription through a human gate is what made validation stall on "WS-07
depends on WS-03, go fix the manifest." So the runner merges declared edges
into the manifest itself and logs what it merged.

Exactly two outcomes still stop for a human, and neither is about an edge:

- **A cycle.** Two workstreams that depend on each other are not badly
  recorded, they are badly decomposed — they are one workstream, or the split
  is in the wrong place. The run ends `REQUIRES_REPLAN` and the manifest is
  left **unchanged**, since a cyclic manifest is one neither `validate` nor
  `build` can order.
- **An unmet requirement.** Work the program needs that no workstream
  provides is missing scope, which is a planning decision. The run ends
  `REQUIRES_REPLAN`; valid edges are still merged first.

Everything else settles on its own. A workstream that named `needs` is
re-authored with that spec in hand, levels are recomputed, and the loop
repeats until no author asks for anything — bounded by
`author.maxReconcilePasses` (default 3). It terminates because declared edges
only ever grow; the cap exists for an agent that keeps asking for the same
thing, and hitting it fails the run rather than looping.

This is why `author` requires `scope` on every workstream in the manifest
(`summary`, plus optional `includes` and `excludes`) and refuses to run
without it — a workstream with no scope is invisible in the roster. An
exclusion carries more weight than it looks: it tells other authors that
something is *deliberately* not covered, which prevents both duplicated work
and a silently missing requirement. `/plan-program` produces these.

Tune the fan-out under `author` in `pipeline.config.json`:

```json
{ "author": { "concurrency": 4, "maxDependencySpecChars": 120000 } }
```

`concurrency` bounds agents spawned at once inside one level. When a
workstream's direct dependency specs exceed `maxDependencySpecChars`, the
largest are cut back to their roster entry and the run says which — a wide
fan-in, not a deep chain, is what makes a brief large. A demoted dependency
is still visible in the roster, so the author can ask for it back through
`needs`.

A level that does not fully succeed stops the run: later levels read the
specs it was supposed to produce. Specs that already exist are skipped unless
`--force` is passed, so a failed run resumes without redoing work.

### `build`

Execute a program's workstreams in dependency order with the configured agent.
The runner verifies every workstream itself by running the `verify` commands
from `pipeline.config.json`, writes workstream status back to the manifest
(`in_progress`, `complete`, `failed`), commits each verified workstream,
resumes by skipping workstreams already marked `complete`, and appends
structured JSON events to
`build-logs/{program-id}-build-{timestamp}.jsonl`.

```sh
npx --yes @wildorder/program-pipeline build phase-1 --cwd . --dry-run
npx --yes @wildorder/program-pipeline build phase-1 --cwd . --yes
npx --yes @wildorder/program-pipeline build phase-1 --cwd . --yes --start-from WS-03
npx --yes @wildorder/program-pipeline build phase-1 --cwd . --yes --no-commit
```

Configure the runner in `pipeline.config.json`:

```json
{
  "agent": { "command": "claude", "args": ["-p", "--model", "sonnet"], "promptMode": "stdin" },
  "authorAgent": { "command": "claude", "args": ["-p", "--model", "opus"], "promptMode": "stdin" },
  "validatorAgent": { "command": "codex", "args": ["exec"] },
  "models": { "author": "claude-code/opus", "validator": "gpt-sol" },
  "verify": { "build": "npm run build", "test": "npm test" },
  "build": { "maxRecoveryAttempts": 1, "verifyRetries": 1, "logDir": "build-logs", "commit": true, "critiqueTests": false },
  "validate": { "rounds": 2, "strict": false, "scopeDownAfterRound": 2 }
}
```

`build.maxRecoveryAttempts` bounds recovery agents per workstream, and
`build.verifyRetries` (default 1) re-runs a failed verify command before the
failure counts against the attempt — absorbing flaky tests instead of
spending a recovery agent on them. The runner also fingerprints the working
tree before each workstream's first attempt (persisted to
`build-logs/{program-id}-baselines.json`): an agent that changes nothing on
an untouched workstream is failed as a no-op, but once earlier attempts have
left work in the tree, a no-op attempt proceeds to verification instead — so
a resumed build cannot dead-end on already-implemented work. A nonzero agent
exit moments after spawn with an unchanged tree stops the build as an agent
environment failure (usage limit, credentials, startup problem) rather than
burning recovery attempts on instant repeats of the same error.

**Test critique.** Independent verification proves only that the
implementation and its tests agree — and the same agent wrote both. With
`build.critiqueTests` enabled, the runner hands each workstream's diff and
spec to the `validatorAgent` after verification passes and before the commit,
asking whether a plausible wrong implementation would pass, whether every
acceptance criterion has a test that could fail, whether failure paths are
reached, and whether any test was weakened or deleted to make the suite green.
It annotates and never blocks: the findings land in the events log as
`test-critique` and in the build result, but a verified commit still lands.

**Commits.** The runner owns commits; workstream agents are instructed never
to commit. With `build.commit` enabled (the default), each workstream is
committed as `build({program-id}): {ws-id} {name}` immediately after it passes
independent verification and its manifest status is written — so every
runner-authored commit is green, and a failed build leaves exactly the work
that did not pass in the working tree. `--no-commit` overrides the config for
one run, and commits are skipped automatically outside a git repository.

Because those commits must not absorb unrelated work, a dirty working tree
aborts the build before it starts, listing the offending paths: commit or
stash them, or re-run with `--no-commit`. The single exception is the
uncommitted work a previous failed run of the same program left behind
(fingerprinted in `build-logs/{program-id}-uncommitted.json`), which is
accepted so resuming after a failure needs no cleanup. A commit that git
itself refuses — a rejecting hook, an unset `user.email` — is reported as
`commit failed` and leaves the verified changes in the tree; it never fails
the workstream, and the runner never bypasses hooks to force one through.

### Agent summaries

Every agent the runner spawns is asked to end its reply with a fenced
`summary` block, and the runner reads that block back **verbatim** — it is
never paraphrased, and nothing sits between the agent and the log to
paraphrase it.

This closes the gap in the other direction from the composed brief. Agent
output previously had two destinations: a machine parse (findings, verdicts)
or a failure path. A workstream that passed surfaced nothing about what the
agent concluded, and the critic's reasoning was discarded the moment its
findings were parsed out — you learned *what* it flagged, never *why it
thought so*.

Summaries surface in three places:

- live on the progress stream, as each agent exits;
- in the events log as an `agent-summary` event carrying `role`, the text,
  and `promptBytes`;
- in the final report — under each workstream for `build`, and per round as
  `criticSummary` / `writerSummary` for `converge`.

`promptBytes` is deliberate telemetry. Brief size is the input to every
decision about how much context an agent can be given, and estimating it from
spec line counts is guesswork; recording it per invocation makes it a
measurement after one real run.

A missing block never fails anything. The runner falls back to the tail of
the agent's output, marks it `(no summary block)`, and carries on — an agent
that forgets a fence still did the work, and failing a verified workstream
over a formatting slip would trade a real result for a cosmetic one.

### Spec validation: the convergence loop

```sh
npx --yes @wildorder/program-pipeline converge phase-1
npx --yes @wildorder/program-pipeline converge phase-1 --rounds 3 --strict
```

Each round pairs one **critic**, which reports findings and never edits, with
one **writer**, which applies fixes and may decline any finding it believes is
wrong. The roles alternate between the `authorAgent` and `validatorAgent`
blocks, so neither model ever grades its own writing — a critic allowed to fix
tends to stop finding, converging on its own taste rather than on quality.

Note that the loop runs `authorAgent`, **not** `agent`. Building a workstream
and judging a spec are different jobs: `agent` is frequently set to a cheaper
model on purpose, and that model has no business critiquing and rewriting
specs a stronger one authored. With no `authorAgent` configured the loop falls
back to the build agent and says so loudly in its output — treat that warning
as a configuration bug, not a note.

The loop names both resolved agents before it spends anything, so an
unintended model shows up in the first line of output.

The runner composes both briefs itself. That is the point of putting the loop
in the package rather than in a skill: when an orchestrating agent assembled
the external validator's prompt, it could fold in its own framing ("ignore
length, ignore file counts") and quietly narrow the gate before the critique
began. There is no longer a seam to do that through.

Rounds 1 and 2 always cover the whole program; scoping to changed workstreams
is allowed only from round 3. Scoping earlier would use the declared
dependency graph to choose what to re-check, but finding *undeclared*
dependencies is part of the job — a workstream that silently consumes
another's output is not in the producer's neighbor set.

The loop ends as **converged** (a round produced no new blocker or major
findings), **cap-reached** (the round cap ran out, a normal outcome given how
subjective majors are), **requires-replan** (a structural defect no spec edit
can fix — the loop stops immediately rather than polishing a workstream that
should be split), or **aborted**. How the loop stopped and whether the gate
passed are decided separately: the gate comes from the deterministic
validator over the final tree.

Findings the writer declined and the critic then re-raised are reported as
**open disagreements** for a human to settle, rather than resolved by whoever
edits last.

**Severity is decided by policy, not by prompt.** A finding keeps its severity
only if it cites a locatable cause — a file and line range, or a named
concern. One supported solely by a measurement (line count, file count) is
downgraded to `advisory` and drops out of the gate. This is the opposite of
suppression: the critic may argue a spec is too long as forcefully as the
evidence warrants, it just has to say why. "WS-04 is 800 lines" is set aside;
"WS-04 bundles auth and telemetry, split at step 12" and "lines 210-340
restate the program doc verbatim" keep full severity and stay actionable.

### The three agent roles

Model roles are explicit, not implicit. Three separate blocks, because three
separate jobs:

| Block | Job | Used by |
| --- | --- | --- |
| `agent` | Implements workstreams. A cheaper model is usually the right call. | `build` |
| `authorAgent` | Reasons about specs — critic and writer in the loop. | `converge` |
| `validatorAgent` | The independent second opinion. | `converge`, test critique |

Each block declares an invocation mechanism — command, base args, prompt mode
— and the runner passes the args verbatim. A model flag for that CLI belongs
there, spelled the way the CLI expects.

By convention `validatorAgent` is the exception: leave its model flag out and
let the external CLI run its own default. The role wants a second opinion
from a different provider, which that default already is, so naming a model
only adds a name to get wrong or to outlive its model. On `agent` and
`authorAgent` the tier is the point, so name it.

Test critique stays on `validatorAgent` deliberately: it reviews code the
build agent wrote, so the independent reviewer is the point.

`models` is a different mechanism and does not reach the runner. It declares
**host-neutral intent** for workflows that switch models *in-host* (the
authoring skill, for example). The runner spawns processes and needs a
concrete command, so `models.author: opus-5` has no effect on `converge` —
that is what `authorAgent` is for.

**Model names.** The pipeline has no model registry; every name belongs to
the namespace of the tool that consumes it. Args in `agent` and
`authorAgent` are whatever that CLI accepts — prefer stable aliases over
dated snapshot IDs where the CLI supports them (for example `--model opus`
rather than a dated Opus ID), since aliases track the current model and do
not go stale; pin an exact ID only when you need reproducibility across a
long program. Names in `models` are **host-neutral intent**, not host picker slugs — write
the stable family/tier shorthand (for example `opus-5`, `sol`), and each
host resolves that intent to its own concrete model at run time, stating the
mapping. Host-specific slugs (Cursor variant names and the like) must never
be written into `models` — they are meaningless to other hosts and rot the
fastest. When any configured name genuinely goes stale,
`pipeline.config.json` is the single place to fix it — the workflow skills
are instructed to propose and apply that config fix (with your approval)
rather than patching skill files or working around it.

The agent receives each workstream prompt on stdin by default — keep that
default whenever the agent CLI supports it. Set `"promptMode": "argument"`
only for agents that require the prompt as a positional argument; in that
mode the runner always spawns the command directly (no shell), because a
shell — cmd.exe on Windows in particular — mangles multiline prompt
arguments. Consequence on Windows: argument mode cannot launch `.cmd` shims
(npm-installed CLI wrappers); point `command` at a real executable or use
stdin mode. `PROGRAM_PIPELINE_AGENT_COMMAND` is honored as a fallback agent
command. `requireApprovalBeforeBuild` is the only approval gate — projects
initialized by this package default it to `false`, so invoking the build
workflow starts the build; set it to `true` when you want every build to stop
for confirmation first (execution then requires `--yes`). Use `--dry-run` to
inspect the plan without running anything. A workstream passes only
when the agent exits successfully **and** every `verify` command exits
successfully — verification alone never rubber-stamps a crashed agent, and an
agent's success claim is never trusted without verification. `--start-from`
is rejected when it would skip a dependency that is not already `complete`.

Exit codes: `0` success or planned, `1` failed or aborted, `2` approval
required (blocked by `requireApprovalBeforeBuild` without `--yes`).

Workstream agents start as clean headless sessions: the runner strips
inherited agent-session environment markers (`CLAUDECODE`, `CLAUDE_CODE_*`,
`CURSOR_AGENT`, `CURSOR_TRACE_*`) before spawning, so a build launched from
inside Claude Code or Cursor cannot make the child CLI think it is attached
to the orchestrating session.

**No-op guard.** A workstream is only complete when the agent exited
successfully, the git working tree actually changed during the attempt,
every file the spec declares `(NEW)` exists afterward, and all `verify`
commands pass. An idle agent on an already-green repository fails the
attempt instead of being falsely completed. The tree check needs a git
repository (a `tree-guard-disabled` event is emitted without one; the
declared-files check still applies), and deliberately re-running an
already-implemented workstream via `--start-from` will fail as a no-op —
that is the guard working as intended.

### `review`

Read-only architecture and integration review of a planned program.

```sh
npx --yes @wildorder/program-pipeline review phase-1 --cwd .
```

Runs the `validatorAgent`, never the author — a reviewer that is the same
model as the author is reviewing its own taste. It reports and never edits:
mechanical checks belong to `validate` and spec repair belongs to `converge`,
so what is left for a review is the class of problem that only shows up when
you hold the whole program at once — two workstreams defining the same type
differently, a package no workstream touches, an ordering that cannot work.

Findings go through the same cause-required severity policy as the
convergence loop, so a review cannot bypass it either: a finding supported
only by a line count is downgraded to advisory. The report is written to
`docs/programs/{program-id}-review.md`.

A review reports rather than passes or fails, so it exits `0` even with
findings. Only an unusable review — no `validatorAgent`, a crashed agent —
exits `1`.

### `as-built`

Snapshot the system that was actually built.

```sh
npx --yes @wildorder/program-pipeline as-built phase-1 --cwd .
```

Runs the build `agent`: this is a codebase scan and a piece of writing, not a
judgment about someone else's work. The agent writes `docs/as-built.md` by
reading real source files — entry points, schemas, route registrations,
infrastructure config — and documenting what exists rather than what the
program document said would exist.

The runner then archives a copy to `docs/snapshots/as-built-{program-id}.md`
itself. Copying a file to a versioned path is deterministic, and handing
deterministic work to a model is how a snapshot ends up quietly differing
from its archive.

Same no-op guard as everywhere else: an agent that exits cleanly without
writing the file has not produced a snapshot, and the run aborts.

### `criteria`

Collect every workstream's acceptance criteria into one document, review it,
and record approval.

```sh
npx --yes @wildorder/program-pipeline criteria phase-1 --cwd .
npx --yes @wildorder/program-pipeline criteria phase-1 --cwd . --approve
```

This is the one human gate the pipeline keeps, and the only one worth having.
Everything else it checks is fact-shaped — a dependency exists or it does
not, a verify command exits zero or it does not — and those settle
themselves. Acceptance criteria encode what "done" means, which is a scoping
decision, and no amount of model review substitutes for the person who owns
the outcome saying "yes, that is what I asked for".

Two things follow. It is **batched**: every criterion in the program lands in
`docs/programs/{program-id}-criteria.md` and is reviewed in one pass, not
workstream by workstream. And approval is **keyed to a content hash of the
criteria themselves**, so editing a criterion afterwards lapses the approval
automatically rather than leaving a stale sign-off attached to text nobody
agreed to. Editing anything else in a spec — a goal, an implementation step —
does not.

Run it **after `converge`**, not before: the loop edits specs, so approving
first would mean re-approving after every round.

Exit codes: `0` approved, `1` aborted, `2` review required.

To make it a real gate, turn it on in `pipeline.config.json`:

```json
{ "build": { "requireCriteriaApproval": true } }
```

`build` then refuses to start until the current criteria are approved, and
refuses again if they change afterwards. It defaults to `false` because
enabling it retroactively would block the next build of every existing
project — this is opt-in per project, not a silent change of behavior.

### `validate`

Run deterministic validation for a program's manifest and workstream specs.

```sh
npx --yes @wildorder/program-pipeline validate phase-1 --cwd .
npx --yes @wildorder/program-pipeline validate phase-1 --cwd . --strict
npx --yes @wildorder/program-pipeline validate phase-1 --cwd . --json
```

### `doctor`

Print the resolved skills root for every target, then verify that the installed
package contains every required skill, template, and schema.

```sh
npx --yes @wildorder/program-pipeline doctor
```

```text
skills roots
  Claude Code  /home/dev/.claude/skills    [detected, default]
  Cursor       /home/dev/.cursor/skills    [detected, default]
  Codex        /home/dev/.agents/skills    [not detected, default]
  Gemini CLI   /home/dev/.gemini/skills    [not detected, default]
  OpenClaw     /home/dev/.openclaw/skills  [not detected, default]
```

The trailing tag is the detection state and which resolution layer chose the
path (`flag`, `env`, or `default`) — start here when an install lands somewhere
your agent does not read.

## Skills, and why there are only two

Two skills install into your agent. Both are the steps where a human decides
something:

1. `/init-project` — set the project up: greenfield or brownfield, git, and
   which model fills each of the three roles.
2. `/plan-program` — turn the vision and current as-built state into a
   program plan, a manifest, and a scope for every workstream.

Everything after planning is a CLI command:

```text
/plan-program        HUMAN   design, scope, decompose
author               machine one clean agent per workstream, per level
converge             machine critic/writer spec convergence
review               machine read-only architecture review
criteria --approve   HUMAN   the definition of done
build                machine implement, verify, commit
as-built             machine snapshot what was actually built
```

Those steps used to be skills too, and the move out of the agent session is
the point. A skill runs *inside* whatever agent invoked it, which means the
orchestrator authored specs in a context already carrying the whole planning
conversation, composed its own instructions, summarized its own results, and
then graded its own output. Each of those is a seam, and the commands close
them: the package composes every brief, spawns a clean agent per unit of
work, and records what came back verbatim.

An install removes retired skills it finds — the old copies would keep
telling an agent to do that work in-session. Ones you have edited are
reported and left alone rather than deleted.

The same skill names and semantics are packaged for Cursor, Claude Code,
OpenClaw, Codex, and Gemini CLI; only their installation roots differ.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm pack --dry-run
```

## License

MIT © 2026 Wing It Labs
