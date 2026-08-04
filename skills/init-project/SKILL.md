---
name: init-project
description: Initialize a repository with the standard program-pipeline structure, templates, configuration, and portable agent workflows.
argument-hint: "[project-root]"
disable-model-invocation: true
---

# Initialize a project

Use the supplied argument as the project root. When omitted, use the current
working directory.

## Step 1 — Gather project information

Ask for any missing values and wait for the response:

1. Project name.
2. Primary language and technology stack.
3. One-line product description.

## Step 2 — Run the deterministic initializer

Invoke the installed package from the target directory:

```powershell
npm exec program-pipeline -- init --cwd "{project-root}" --name "{project-name}" --stack "{stack}" --description "{description}"
```

If the package is not installed yet, use the public package:

```powershell
npx --yes @wildorder/program-pipeline init --cwd "{project-root}" --name "{project-name}" --stack "{stack}" --description "{description}"
```

Do not manually reproduce the templates. The CLI is the canonical write path
and will create the standard directories, `docs/vision.md`, `AGENTS.md`,
`CLAUDE.md`, `pipeline.config.json`, and the `build-logs/` ignore entry
without overwriting existing files. When a `package.json` with scripts
exists, the initializer prefills the config's `verify` commands from it.

The universal directives embedded in `AGENTS.md` come from the packaged
template by default. A user or organization override is honored automatically
from `~/.program-pipeline/universal-directives.md`, or pass
`--directives <path>` explicitly when the user names a directives file.

## Step 3 — Install portable workflows

When the package is present as a project dependency, install all supported
agent adapters:

```powershell
npm exec program-pipeline -- install --cwd "{project-root}" --targets cursor,claude,openclaw
```

Do not use `--force` unless the user explicitly approves replacing a reported
skill conflict.

## Step 4 — Report

Report:

1. Files created.
2. Existing files skipped.
3. Skill conflicts, if any.
4. Warnings from the initializer.
5. Next steps: complete `docs/vision.md`, add project conventions to
   `AGENTS.md`, and invoke `/plan-program`.
