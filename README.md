# @wildorder/program-pipeline

A provider-neutral TypeScript CLI and portable Agent Skills package for planning,
validating, building, and documenting engineering programs.

## Get started

```sh
# 1. One-step setup: adds the devDependency and installs the workflow skills
#    (defaults to all targets: cursor, claude, openclaw, codex, gemini;
#    narrow with --targets). Commit the generated files so every dev gets
#    the workflows on git pull.
npx @wildorder/program-pipeline setup

# 2. In your agent, run the guided setup
#    /init-project
```

`/init-project` interviews you for the project details, runs the deterministic
`init` scaffolding under the hood, and finishes by pointing you at
`/plan-program` to plan your first program. From there the flow is:
plan → author workstreams → validate → review → build → update as-built.

## Install

Published on the public npm registry as
[`@wildorder/program-pipeline`](https://www.npmjs.com/package/@wildorder/program-pipeline) —
no tokens, private registry configuration, or repository credentials required:

```sh
npm install --save-dev @wildorder/program-pipeline
```

Run the local executable with `npx`:

```sh
npx program-pipeline --help
```

## CLI

### `setup`

One-step onboarding for a project: adds `@wildorder/program-pipeline` as a
devDependency (skipped with a warning when no `package.json` exists) and then
runs the skills installer. Accepts the same `--targets` and `--force` options
as `install`.

Re-running `setup` is also the update path: it bumps the dependency to the
latest published version and refreshes all unmodified package-generated
skills to match, leaving hand-edited skills untouched (reported as
conflicts). Commit the resulting diff. Teams pinned to an older version
should instead use `npm update` plus `npm exec program-pipeline -- install`.

```sh
npx @wildorder/program-pipeline setup
npx @wildorder/program-pipeline setup --targets claude
```

### `init`

Create the standard program-pipeline structure in a new project, or adopt an
existing one. Existing files are never overwritten.

```sh
npm exec program-pipeline -- init --cwd .
npm exec program-pipeline -- init --cwd . --name "Acme Dashboard" --stack "TypeScript/Node" --description "Operations dashboards for growing teams."
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

Install all packaged workflow skills for one or more supported agents. The
default target set is `cursor,claude,openclaw,codex,gemini`.

```sh
npm exec program-pipeline -- install --cwd .
npm exec program-pipeline -- install --cwd . --targets "cursor,claude"
```

Skills are installed at:

- Cursor: `.cursor/skills/<skill-name>/SKILL.md`
- Claude Code: `.claude/skills/<skill-name>/SKILL.md`
- OpenClaw: `skills/<skill-name>/SKILL.md`
- Codex: `.agents/skills/<skill-name>/SKILL.md`
- Gemini CLI: `.gemini/skills/<skill-name>/SKILL.md`

Note that `.agents/skills` is the cross-tool shared directory — some other
agents (Cursor among them) also read it, so targeting `codex` alongside
`cursor` can surface the same skill twice in tools that scan both locations.

Before writing, the installer scans matching project and user-level command and
skill directories for every targeted agent. Alternate definitions
produce detailed warnings but remain untouched. A user-authored or edited file
at an installation destination is a blocking conflict: the entire installation
aborts before writing anything. Identical skills are skipped and unmodified
package-generated skills update safely. Use `--force` only when you explicitly
want packaged content to replace destination conflicts.

### `build`

Execute a program's workstreams in dependency order with the configured agent.
The runner verifies every workstream itself by running the `verify` commands
from `pipeline.config.json`, writes workstream status back to the manifest
(`in_progress`, `complete`, `failed`), resumes by skipping workstreams already
marked `complete`, and appends structured JSON events to
`build-logs/{program-id}-build-{timestamp}.jsonl`.

```sh
npm exec program-pipeline -- build phase-1 --cwd . --dry-run
npm exec program-pipeline -- build phase-1 --cwd . --yes
npm exec program-pipeline -- build phase-1 --cwd . --yes --start-from WS-03
```

Configure the runner in `pipeline.config.json`:

```json
{
  "agent": { "command": "claude", "args": ["-p", "--model", "sonnet"], "promptMode": "stdin" },
  "validatorAgent": { "command": "codex", "args": ["exec", "--model", "gpt-sol"] },
  "models": { "author": "claude-code/opus", "validator": "gpt-sol" },
  "verify": { "build": "npm run build", "test": "npm test" },
  "build": { "maxRecoveryAttempts": 1, "logDir": "build-logs" }
}
```

Model roles are explicit, not implicit: the `agent` block is the single
source of truth for what builds each workstream (the runner prints the
resolved agent line in dry-run, approval, and build output), while `models`
declares which model authors workstream specs and which validates them — the
authoring and validation workflows read these as defaults and warn when the
author and validator are the same model, since same-model validation weakens
the gate.

The validator works from any host: when the host can switch models in-host
(for example Cursor), `models.validator` is honored directly and bills
through the host; when it cannot (for example a cross-provider validator
from Claude Code), the workflows fall back to running the `validatorAgent`
command as a separate process, which bills through that CLI's own account.
Same validator identity, host-appropriate mechanism.

**Model names.** The pipeline has no model registry; every name belongs to
the namespace of the tool that consumes it. Args in `agent` and
`validatorAgent` are whatever that CLI accepts — prefer stable aliases over
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
command. When `requireApprovalBeforeBuild` is `true`, execution requires
`--yes`; use `--dry-run` to inspect the plan first. A workstream passes only
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

### `validate`

Run deterministic validation for a program's manifest and workstream specs.

```sh
npm exec program-pipeline -- validate phase-1 --cwd .
npm exec program-pipeline -- validate phase-1 --cwd . --strict
npm exec program-pipeline -- validate phase-1 --cwd . --json
```

### `doctor`

Verify that the installed package contains every required skill, template, and
schema.

```sh
npm exec program-pipeline -- doctor
```

## Installed workflow skills

After running `program-pipeline install`, invoke the skills from your agent's
command interface in this order as needed:

1. `/init-project` — bootstrap the project structure and templates.
2. `/plan-program` — turn the vision and current as-built state into a program
   plan and manifest.
3. `/author-workstreams` — create self-contained implementation specs and run
   the validation gate.
4. `/validate-workstreams` — independently check coverage, dependencies,
   traceability, and build readiness.
5. `/review-program` — perform a read-only architecture and integration review.
6. `/build-program` — execute manifest workstreams through the build pipeline.
7. `/update-as-built` — snapshot the system that was actually built.

The same skill names and workflow semantics are packaged for Cursor, Claude
Code, OpenClaw, Codex, and Gemini CLI; only their installation roots differ.

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
