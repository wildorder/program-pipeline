---
name: build-program
description: Execute a program's dependency-ordered workstreams through the project's automated build pipeline with validation, confirmation, monitoring, and verification gates. Use when a user asks to build, execute, or resume a planned program.
argument-hint: "[program-id]"
disable-model-invocation: true
---

# Build Program

Execute a program's workstreams through the automated build pipeline.

## Step 1 — Identify the program

Use the supplied program ID. If none was provided, ask which program to build and wait for the answer.

## Step 2 — Run the preflight validation gate

Before presenting the execution order, invoke the `validate-workstreams` skill for the same program ID or execute its checks inline.

Use a strong code-validation model when the host supports model selection. If no model-selection capability exists, use the current model and preserve the same validation checks and severity rules.

- If validation returns `FAILED` with blockers, stop and ask whether to run focused fixes first.
- If validation passes, or only minor findings remain, continue.

## Step 3 — Show the execution plan

Read `docs/programs/{program-id}-manifest.json` to obtain the workstream list.

Display:

- Total workstream count.
- Dependency-respecting execution order.
- Estimated effort per workstream: S, M, or L.
- Workstreams already marked complete when resuming.

## Step 4 — Check for the build script

Check whether `build-product.ps1` exists in the project root.

If it exists:

- Determine whether it supports a `-Program` parameter.
- If it does, confirm maximum turns, budget per workstream, and model settings with the user. Default to a balanced build-capable model and escalate to a higher-capability model only when needed.
- If it does not, explain that the script must be parameterized to read the manifest, or offer to run it with manual workstream overrides.

If it does not exist:

- Tell the user that the automated workflow requires a build script.
- Offer to create one from the standard pipeline pattern: sequential workstream execution, verification gates, and version-control checkpoints.

## Step 5 — Execute

After the user confirms, run:

```powershell
.\build-product.ps1 -Program {program-id}
```

To resume from a specific workstream, run:

```powershell
.\build-product.ps1 -Program {program-id} -StartFrom {ws-id}
```

## Step 6 — Monitor and report

Monitor execution and report:

- Which workstreams passed or failed verification gates.
- Total elapsed time.
- Any workstreams that required automatic fix attempts.
- Whether any failure requires manual intervention.
