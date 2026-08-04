---
name: review-program
description: Perform a read-only architecture and integration review of a planned program and its workstream specs. Use after workstream validation and before implementation to find coverage gaps, contradictions, missing dependencies, over-engineering, and integration risks.
argument-hint: "<program-id>"
disable-model-invocation: true
---

# Review a program

Review a program's workstreams for gaps, contradictions, and risks before implementation.

This is read-only. Do not rewrite any file. Assume the standard workstream validation has already run; focus on architecture and integration risks beyond mechanical spec checks.

## 1. Identify the program

Use the positional program ID when supplied. Otherwise ask for it and wait.

## 2. Load all relevant material

Read:

- The vision document at `visionPath` from `pipeline.config.json`; use `docs/vision.md` only when no configuration exists.
- `docs/programs/{program-id}-program.md`.
- `docs/programs/{program-id}-manifest.json`.
- Every workstream spec under `tasks/{program-id}/`.
- `docs/as-built.md`, when present.

## 3. Analyze with evidence

Answer every section below. Cite workstream IDs, file paths, and line references. Be direct and evidence-based.

### Coverage gaps

- Which program features or requirements have no workstream coverage?
- Which program success criteria have no mapped workstream?
- Which manifest packages are untouched by all workstreams?

### Contradictions between workstreams

- Do workstreams define the same type, function, or interface differently?
- Do they conflict on data model, API shape, or behavior?
- Does an `Existing Interfaces to Consume` section disagree with the producing workstream?

### Missing dependencies

- Does a workstream consume types, functions, files, or packages from another workstream without declaring that dependency?
- Does the manifest graph match the dependencies implied by the specs?
- Is manifest execution order safe?

### Over-engineering and sizing

- Does any workstream exceed program scope?
- Are abstractions, strategies, or extension points unsupported by success criteria?
- Flag workstreams touching more than eight core files or combining unrelated concerns.
- Treat spec length above roughly 200 lines only as a review prompt, never as a defect by itself; concrete interfaces, implementation steps, tests, and acceptance criteria must not be penalized for necessary detail.

### Integration risk

- Which workstreams have the most cross-package dependencies?
- Where can package-boundary types, behavior contracts, or shared state drift?
- Which assumptions remain unspecified?
- Which workstreams modify the same files?

## 4. Recommend

End with one flat list of specific recommendations. Cite workstream IDs and file paths. Include blockers and advisory risks without forcing an overall pass/fail verdict; the user decides what to change.
