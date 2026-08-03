---
name: update-as-built
description: Update and archive the as-built system snapshot after a completed program by inspecting the actual codebase rather than relying on the plan. Use when a user asks to refresh system documentation after program completion.
argument-hint: "[program-id]"
disable-model-invocation: true
---

# Update As-Built

Update the as-built system snapshot after a completed program.

## Step 1 — Identify the program

Use the supplied program ID. If none was provided, ask which program just completed and wait for the answer.

## Step 2 — Load context

Read:

- `docs/as-built.md`, if it exists.
- `docs/programs/{program-id}-program.md`.
- `AGENTS.md`.

## Step 3 — Scan the actual codebase

Produce an accurate snapshot by reading real source files. Catalog what exists, not what was planned. Prioritize:

- Entry points and barrel files such as `index.ts`, `__init__.py`, and `mod.rs` to identify key exports per package or module.
- Schema files for the data model, including database schemas, SQL migrations, and ORM models.
- Route registrations for API endpoints.
- Type definitions for protocols, events, and shared contracts.
- Infrastructure configuration such as Dockerfiles, CI workflows, and infrastructure-as-code modules.

Do not read every file. Read entry points and schema files, then extrapolate the structure carefully from evidence.

## Step 4 — Write the snapshot

Write `docs/as-built.md` with this structure:

```markdown
# {Project Name} — As-Built System Snapshot
<!-- Last updated: {YYYY-MM-DD} after program: {program-id} -->

## Packages & Key Exports
[For each package/module: name, path, 5-10 key exports.
Not exhaustive — focus on public API surface.]

### {package-name} ({path})
Key exports: ...

## Data Model
[Tables/entities with column names and types.
For schema-less stores, document the document shapes.]

## API Endpoints
[Method, path, one-line purpose. Group by domain.]

## Protocols / Events
[Stream events, message types, pub-sub channels, etc.]

## Infrastructure
[CI pipelines, Docker, IaC modules, deployment targets — what is configured.]

## Known Limitations / Tech Debt
[Stubs, missing features, and follow-up needs.
These become candidates for future programs.]

## Programs Completed
[Ordered list of completed program IDs with one-line summary and date.]
```

## Step 5 — Archive

Save a versioned copy to `docs/snapshots/as-built-{program-id}.md` so the system's evolution remains traceable.

## Rules

- Keep `docs/as-built.md` between 200 and 300 lines. It is a curated index, not a code dump.
- Verify against actual source files. Do not trust the program document when implementation differs; document reality.
- Treat the as-built snapshot as the replacement for prior program documents when providing context for the next program. It must be accurate enough that someone reading only `docs/vision.md` and `docs/as-built.md` can plan the next feature set.
