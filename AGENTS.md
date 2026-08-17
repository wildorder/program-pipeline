<!-- BEGIN UNIVERSAL — source: templates/universal-directives.md -->
# Agent Directives: Universal

These directives apply to every agent working in this repository, regardless
of provider or harness.

## Scope and depth

1. SPEC-FIRST: When a workstream spec exists under `tasks/`, read it before
   implementing. Do not invent architecture that contradicts the spec or
   `docs/vision.md`. If the spec is ambiguous, ask — do not guess.

2. ROOT CAUSE OVER SYMPTOM: Prefer the smallest diff that fully solves the
   root cause, not the smallest diff that makes symptoms disappear. When the
   proper fix is out of scope, say so explicitly and propose it as a
   follow-up instead of silently shipping a band-aid.

3. STRUCTURAL FIXES STAY IN SCOPE: If architecture is flawed, state is
   duplicated, or patterns are inconsistent inside the files the task already
   touches, fix it. Do not expand into unrelated modules without asking. On
   question-only or review-only tasks, answer — do not rewrite code unless
   asked.

## Verification

4. VERIFY BEFORE CLAIMING COMPLETION: A successful file write proves nothing
   about correctness. Before reporting a task complete, run the project's
   configured build, type-check, test, and lint commands and fix every
   resulting error. If one of those commands is not configured, state that
   explicitly instead of claiming it passed.

## Edit safety

5. READ BEFORE EDITING: Read a file before modifying it, and re-read any file
   you have not seen recently in a long session before editing it again.

6. EXHAUSTIVE RENAMES: When renaming any function, type, or variable, search
   for direct references, type-level references, string literals, dynamic
   imports, re-exports, and test files. Do not assume one search pass caught
   everything.

## Large tasks

7. WORK IN VERIFIABLE PHASES: Break multi-file work into phases that each
   pass verification on their own. In interactive sessions, pause between
   phases for review; in automated pipeline runs, complete and verify each
   phase before starting the next.

8. PARALLELIZE INDEPENDENT WORK: When the harness supports sub-agents and the
   task spans many independent files, split the work rather than degrading a
   single context; keep tightly coupled changes together.
<!-- END UNIVERSAL -->

---

## Project: Program Pipeline

Program Pipeline is a provider-neutral TypeScript CLI and Agent Skills package
for planning, authoring, reviewing, validating, executing, and snapshotting
engineering programs. Planning is interactive; everything downstream is a
headless command that spawns its own agents.

### Tech Stack

- Node.js 20+
- TypeScript ESM in strict mode
- Commander for the CLI
- Zod and JSON Schema validation
- Vitest for tests

### Conventions

- Command and workflow IDs are lowercase kebab-case.
- Deterministic behavior **and every agent brief** belong in `src/`. A step
  that spawns an agent is a CLI command whose brief the package composes, so
  nothing can quietly narrow it, summarize its result, or grade its own
  output. `skills/` holds only the two steps where a human decides something:
  `init-project` and `plan-program`.
- Every spawned agent ends its reply with a fenced `summary` block, and the
  runner records that text verbatim. See `src/agent-summary.ts`.
- Parsing a model reply means stating the shape you expect. `extractJson`
  takes a predicate; never take "the last JSON block" and hope. A reply that
  never produces the contract is a protocol failure, not an empty result —
  a gate that cannot read its critic must not pass.
- Each stage is usable alone and composed by `program-pipeline run`. Adding a
  stage means adding it to `RUN_STAGES` too, or it is unreachable in practice.
- Never overwrite user-authored files without explicit `--force`.
- Keep all workflows provider-neutral and free of product-specific context.
- Use dependency injection for filesystem boundaries that require unit tests.

### Verification

Run `npm run build`, `npm run typecheck`, `npm test`, and
`npm run lint -- --quiet` before reporting completion.
