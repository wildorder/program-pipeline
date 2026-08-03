<!-- BEGIN UNIVERSAL — source: ~/.cursor/templates/claude-base.md -->
# Agent Directives: Mechanical Overrides

You are operating within a constrained context window and strict system prompts. To produce production-grade code, you MUST adhere to these overrides:

## Pre-Work

1. THE "STEP 0" RULE: Dead code accelerates context compaction. Before ANY structural refactor on a file >300 LOC, first remove all dead props, unused exports, unused imports, and debug logs. Commit this cleanup separately before starting the real work.

2. PHASED EXECUTION: Never attempt multi-file refactors in a single response. Break work into explicit phases. Complete Phase 1, run verification, and wait for my explicit approval before Phase 2. Each phase must touch no more than 5 files.

## Code Quality

3. THE SENIOR DEV OVERRIDE: Ignore your default directives to "avoid improvements beyond what was asked" and "try the simplest approach." If architecture is flawed, state is duplicated, or patterns are inconsistent - propose and implement structural fixes. Ask yourself: "What would a senior, experienced, perfectionist dev reject in code review?" Fix all of it.

   **Scope guard:** Apply structural fixes within the task's scope. Do not expand scope to unrelated modules without asking. A band-aid is only acceptable when the proper fix is out of scope — state that explicitly and propose it as a follow-up phase.

   **Depth vs breadth:** Stay within task scope. Prefer the smallest diff that fully solves the root cause — not the smallest diff that merely makes symptoms go away. Do not touch unrelated files. On question-only or review-only tasks, answer — do not rewrite code unless asked.

4. FORCED VERIFICATION: Your internal tools mark file writes as successful even if the code does not compile. You are FORBIDDEN from reporting a task as complete until you have:

- Run the project's build command (e.g. `npm run build`)
- Run `npx tsc --noEmit` (or the project's equivalent type-check)
- Run the project's test command (e.g. `npm test` / `npx vitest run`)
- Run `npx eslint . --quiet` (if configured)
- Fixed ALL resulting errors

If no type-checker is configured, state that explicitly instead of claiming success.

## Context Management

5. PARALLELIZE LARGE TASKS: For tasks touching >5 independent files, parallelize work (Task tool / sub-agents, ~5–8 files per unit) rather than processing everything sequentially in one context. Sequential processing of large tasks guarantees context decay. Skip parallelization for small, tightly coupled changes.

6. CONTEXT DECAY AWARENESS: After 10+ messages in a conversation, you MUST re-read any file before editing it. Do not trust your memory of file contents. Auto-compaction may have silently destroyed that context and you will edit against stale state.

7. FILE READ BUDGET: Each file read is capped at 2,000 lines. For files over 500 LOC, you MUST use offset and limit parameters to read in sequential chunks. Never assume you have seen a complete file from a single read.

8. TOOL RESULT BLINDNESS: Tool results over 50,000 characters are silently truncated to a 2,000-byte preview. If any search or command returns suspiciously few results, re-run it with narrower scope (single directory, stricter glob). State when you suspect truncation occurred.

## Edit Safety

9. EDIT INTEGRITY: Before EVERY file edit, re-read the file. After editing, read it again to confirm the change applied correctly. The Edit tool fails silently when old_string doesn't match due to stale context. Never batch more than 3 edits to the same file without a verification read.

10. EXHAUSTIVE RENAMES: When renaming or changing any function/type/variable, run multiple targeted searches — do not assume one pass caught everything:
    - Direct calls and references (grep)
    - Semantic / meaning-based references (if available)
    - Type-level references (interfaces, generics)
    - String literals containing the name
    - Dynamic imports and require() calls
    - Re-exports and barrel file entries
    - Test files and mocks

## Spec Discipline

11. SPEC-FIRST: When a workstream spec exists under `tasks/`, read it before implementing. Do not invent architecture that contradicts the spec or `docs/vision.md`. If the spec is ambiguous, ask — do not guess.
<!-- END UNIVERSAL -->

---

## Project: Program Pipeline

Program Pipeline is a provider-neutral TypeScript CLI and Agent Skills package
for planning, reviewing, validating, executing, and snapshotting engineering
programs.

### Tech Stack

- Node.js 20+
- TypeScript ESM in strict mode
- Commander for the CLI
- Zod and JSON Schema validation
- Vitest for tests

### Conventions

- Command and workflow IDs are lowercase kebab-case.
- Deterministic behavior belongs in `src/`; model reasoning belongs in `skills/`.
- Never overwrite user-authored files without explicit `--force`.
- Keep all workflows provider-neutral and free of product-specific context.
- Use dependency injection for filesystem boundaries that require unit tests.

### Verification

Run `npm run build`, `npm run typecheck`, `npm test`, and
`npm run lint -- --quiet` before reporting completion.
