# @wildorder/program-pipeline

A provider-neutral TypeScript CLI and portable Agent Skills package for planning,
validating, building, and documenting engineering programs.

> Publishing status: this package is npm-ready, but it has not yet been published
> to npm.

## Install

The package is intended for public, no-auth consumption. After it is published,
install it from the npm registry without tokens, private registry configuration,
or repository credentials:

```powershell
npm install --save-dev @wildorder/program-pipeline
```

Run the local executable with `npx`:

```powershell
npx program-pipeline --help
```

Until npm publishing is performed, use the checked-out repository directly for
development and testing.

## CLI

### `init`

Create the standard program-pipeline structure and starter files in a project.
Existing files are skipped.

The generated `AGENTS.md` embeds a universal directives block. It is resolved
in this order: an explicit `--directives <path>` override, then
`~/.program-pipeline/universal-directives.md`, then the directives template
packaged with this package.

```powershell
npm exec program-pipeline -- init --name "Acme Dashboard" --stack "TypeScript/Node" --description "Operations dashboards for growing teams." --cwd .
```

### `install`

Install all packaged workflow skills for one or more supported agents. The
default target set is `cursor,claude,openclaw`.

```powershell
npm exec program-pipeline -- install --cwd .
npm exec program-pipeline -- install --cwd . --targets "cursor,claude"
```

Skills are installed at:

- Cursor: `.cursor/skills/<skill-name>/SKILL.md`
- Claude Code: `.claude/skills/<skill-name>/SKILL.md`
- OpenClaw: `skills/<skill-name>/SKILL.md`

Before writing, the installer scans matching project and user-level command and
skill directories for Cursor, Claude Code, and OpenClaw. Alternate definitions
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

```powershell
npm exec program-pipeline -- build phase-1 --cwd . --dry-run
npm exec program-pipeline -- build phase-1 --cwd . --yes
npm exec program-pipeline -- build phase-1 --cwd . --yes --start-from WS-03
```

Configure the runner in `pipeline.config.json`:

```json
{
  "agent": { "command": "claude", "args": ["-p"], "promptMode": "stdin" },
  "verify": { "build": "npm run build", "test": "npm test" },
  "build": { "maxRecoveryAttempts": 1, "logDir": "build-logs" }
}
```

The agent receives each workstream prompt on stdin by default; set
`"promptMode": "argument"` for agents that take the prompt as a positional
argument. `PROGRAM_PIPELINE_AGENT_COMMAND` is honored as a fallback agent
command. When `requireApprovalBeforeBuild` is `true`, execution requires
`--yes`; use `--dry-run` to inspect the plan first. A workstream passes only
when the agent exits successfully **and** every `verify` command exits
successfully — verification alone never rubber-stamps a crashed agent, and an
agent's success claim is never trusted without verification. `--start-from`
is rejected when it would skip a dependency that is not already `complete`.

Exit codes: `0` success or planned, `1` failed or aborted, `2` approval
required (blocked by `requireApprovalBeforeBuild` without `--yes`).

### `validate`

Run deterministic validation for a program's manifest and workstream specs.

```powershell
npm exec program-pipeline -- validate phase-1 --cwd .
npm exec program-pipeline -- validate phase-1 --cwd . --strict
npm exec program-pipeline -- validate phase-1 --cwd . --json
```

### `doctor`

Verify that the installed package contains every required skill, template, and
schema.

```powershell
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
Code, and OpenClaw; only their installation roots differ.

## Development

Requires Node.js 20 or newer.

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm pack --dry-run
```

## License

MIT © 2026 Wing It Labs
