---
name: init-project
description: Initialize a new repository or adopt an existing one into the program-pipeline structure, including deriving the vision and as-built docs from existing code. Use when a user asks to set up, initialize, or onboard a project for the program pipeline.
argument-hint: "[project-root]"
disable-model-invocation: true
---

# Initialize or adopt a project

Use the supplied argument as the project root. When omitted, use the current
working directory.

## Step 1 — Detect project type

Inspect the root. If it contains source code, a populated README, or other
project documentation, treat this as a **brownfield adoption**. An empty or
near-empty directory is a **greenfield initialization**.

## Step 2 — Ask about version control upfront

Check whether the root is inside a git repository
(`git rev-parse --is-inside-work-tree`). Ask these questions now, alongside
the project questions — never defer them to a suggested next step:

1. If it is **not** a repository: "Initialize a git repository here?" If yes,
   run `git init` before any scaffolding so everything that follows is
   tracked from the start.
2. In all cases: "Commit the pipeline setup when finished?" If yes, plan to
   commit at the end of this workflow.
3. Brownfield with uncommitted changes: point out the dirty tree and confirm
   that the final commit should include only the files this setup created or
   modified, keeping the user's in-progress work out of it.

Record the answers and apply them in Step 7. If the user declines a
repository entirely, warn that build checkpoints and rollback will be
unavailable, then proceed.

## Step 3 — Gather project information

The initializer resolves defaults on its own: name and description from
`package.json`, and the stack by scanning manifests (package.json,
tsconfig.json, pyproject.toml, go.mod, Cargo.toml).

- Greenfield: ask for the project name, stack, and one-line description, and
  wait for the response.
- Brownfield: state the values you expect detection to produce and ask only
  about gaps or corrections. Do not re-ask for what the repository already
  declares.

### Model roles

Also ask which models fill the pipeline's three roles. Never leave this
implicit — it is the most consequential configuration in the pipeline:

1. **Builder** — the agent CLI command (and model) the build runner executes
   for each workstream, for example `claude -p --model sonnet`. Written to
   the `agent` block of `pipeline.config.json`.
2. **Author** — the model that writes workstream specs in
   `author-workstreams`. Written to `models.author`.
3. **Validator** — the model that independently validates specs. Written to
   `models.validator`. Recommend a different model or provider than the
   author to reduce correlated errors; if the user picks the same one, note
   the tradeoff and respect the choice.

**Always set `validatorAgent`.** Alongside `models.validator`, always
propose and write the external agent command that runs the validator model —
for example `{ "command": "codex", "args": ["exec", "--model", "gpt-sol"] }`
for a GPT validator, or `{ "command": "claude", "args": ["-p", "--model",
"opus"] }` for an Anthropic one. Do not skip it because the current host can
switch models in-host: the config describes the team's pipeline, and other
hosts (or teammates) without in-host switching depend on the fallback. Hosts
that can switch in-host ignore it; hosts that cannot use it (each mechanism
bills through its own account). Check whether the external CLI is available
on this machine and warn if it is not installed or authenticated — but still
write the configuration.

If the user has no preference, record the host's current model for author,
recommend a distinct validator, and leave the builder for the
`build-program` workflow to configure — but say so explicitly in the report.

Ask the Step 2 and Step 3 questions together in one message when possible.

## Step 4 — Run the deterministic initializer

```sh
npm exec program-pipeline -- init --cwd "{project-root}"
```

Add `--name`, `--stack`, or `--description` only for values the user supplied
or detection cannot provide. Do not manually reproduce the templates; the CLI
is the canonical write path. It:

- creates the standard directories and any missing starter files without
  overwriting existing ones;
- merges the universal directives into an existing `AGENTS.md` by adding or
  refreshing only the marked `BEGIN/END UNIVERSAL` block, leaving all other
  content untouched;
- prefills `verify` commands from `package.json` scripts and records existing
  markdown documentation as `contextDocs` in `pipeline.config.json`.

The universal directives come from the packaged template by default; a user
override is honored from `~/.program-pipeline/universal-directives.md`, or
pass `--directives <path>` when the user names a directives file.

After the initializer runs, write the model-role decisions from Step 3 into
`pipeline.config.json`: the builder into `agent`, and the author and
validator into `models`, for example:

```json
"agent": { "command": "claude", "args": ["-p", "--model", "sonnet"] },
"validatorAgent": { "command": "codex", "args": ["exec", "--model", "gpt-sol"] },
"models": { "author": "claude-code/opus", "validator": "gpt-sol" }
```

## Step 5 — Confirm workflow skills are present

Check whether the project already contains installed pipeline skills
(`.cursor/skills/`, `.claude/skills/`, or `skills/`). If any target is
present, the team has already chosen its targets — do not install more, and
do not re-run the installer.

Only when no target is installed at all (for example, when initializing a
different project root than the one this skill is running from), ask the
user which targets they want and run:

```sh
npm exec program-pipeline -- install --cwd "{project-root}" --targets {chosen}
```

Never use `--force` unless the user explicitly approves replacing a reported
skill conflict.

## Step 6 — Brownfield enrichment

Skip this step for greenfield projects.

1. **Snapshot reality.** Follow the scanning approach of the
   `update-as-built` skill — entry points, schema files, route registrations,
   shared contracts, infrastructure config — and write `docs/as-built.md`
   noting it as the initial adoption snapshot. This grounds all later
   planning in what actually exists.
2. **Author the vision.** The CLI scaffolded `docs/vision.md` as a template.
   Draft its real content from the as-built snapshot plus a short interview:
   what the product is for, target users, where it is heading, and what is
   explicitly out of scope. Present the draft for approval before saving.
3. **Complete `AGENTS.md`.** Fill the project Conventions section from
   observed practice — lint and formatter configs, test layout, naming
   patterns — and confirm the generated dependency table reflects the
   packages that matter.
4. **Curate `contextDocs`.** Review the detected list in
   `pipeline.config.json`: remove documents that are stale or irrelevant and
   add any the user names. Planning workflows read every listed document, so
   the list should be signal, not bulk.
5. **Flag legacy pipeline artifacts.** A `build-product.ps1` in the project
   root is a leftover from a previous package version; the build runner is
   now `program-pipeline build`. Tell the user it is obsolete and offer to
   delete it. Treat any other stray pipeline scripts from older versions the
   same way — never adopt them into the new workflow.

## Step 7 — Apply the version-control decisions

Execute what the user approved in Step 2:

- If a commit was approved, stage exactly the files this setup created or
  modified and commit with a message like `chore: adopt program pipeline`.
  Do not stage unrelated in-progress changes.
- If the user declined, leave the working tree as is.

## Step 8 — Report

Report:

1. Files created, updated, and skipped.
2. Skill conflicts, if any.
3. Warnings from the initializer.
4. Brownfield: the as-built and vision drafts produced and any assumptions.
5. Git actions taken (repository initialized, setup committed) or declined.
6. Next step: invoke `/plan-program` for the first program.
