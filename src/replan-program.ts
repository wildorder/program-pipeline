import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveReplannerAgent,
  type AgentRunner,
} from "./agent-runner.js";
import { resolveSummary } from "./agent-summary.js";
import { atomicWriteText } from "./plan-generation.js";
import { appendMemoryEvents, readProgramMemory } from "./program-memory.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";
import {
  recordReplanAttempt,
  replanInputHash,
  replanReportPath,
} from "./replan-report.js";
import { normalizeSubject } from "./findings.js";
import { extractJson, hasArrayKey, type CriteriaPatch } from "./validate-loop.js";
import type { ReplanReport, ReplanResolutionProof } from "./replan-report.js";

export interface ReplanProgramOptions {
  cwd: string;
  programId: string;
  agentRunner?: AgentRunner;
  onProgress?: (line: string) => void;
  now?: () => Date;
}

export interface ReplanProgramResult {
  result: "COMPLETE" | "FAILED" | "ABORTED";
  reason?: string;
  agent?: string;
  generation?: string;
  changedPaths: string[];
}

interface Criterion { id?: unknown; description?: unknown; [key: string]: unknown }

function criteria(manifest: string): Criterion[] {
  const parsed = JSON.parse(manifest) as { successCriteria?: unknown };
  return Array.isArray(parsed.successCriteria) ? parsed.successCriteria as Criterion[] : [];
}

function criteriaChangeAllowed(before: string, after: string, patches: CriteriaPatch[]): boolean {
  const previous = criteria(before);
  const next = criteria(after);
  if (JSON.stringify(previous) === JSON.stringify(next)) return true;
  if (previous.length !== next.length) return false;
  const allowed = new Map(
    patches
      .filter((patch) => patch.kind === "clarification" && patch.intentPreserved)
      .map((patch) => [patch.criterionId, patch]),
  );
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right || left.id !== right.id) return false;
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (typeof left.id !== "string") return false;
    const patch = allowed.get(left.id);
    if (!patch || left.description !== patch.before || right.description !== patch.after) return false;
    const leftRest = { ...left, description: undefined };
    const rightRest = { ...right, description: undefined };
    if (JSON.stringify(leftRest) !== JSON.stringify(rightRest)) return false;
  }
  return true;
}

function brief(
  programId: string,
  report: string,
  program: string,
  manifest: string,
  previousRejection?: string,
  priorCycles?: string,
): string {
  return `You are the headless replanner for program ${programId}.

This is a REPLAN ONLY operation. Read the replan report and repair the plan's
workstream boundaries, dependency graph, taskFile paths, and sequencing so the
reported structural defects are resolved.

Hard rules:
- Do not change user requirements. Success criteria may change only through an
  exact intent-preserving criteriaPatches entry in the report.
- Do not edit source code, tests, AGENTS.md, vision, or any file outside the
  program document and manifest.
- Preserve landed work and preserve superseded task specs as historical files.
- Preserve the selected execution mode unless the report identifies a mode-fit
  defect. When it does, switch modes without changing requirements and update
  program.executionModeReason with the concrete causal evidence. Atomic mode
  must contain exactly one whole-program workstream; orchestrated mode must
  justify its checkpoint graph. Approximate token-band estimates alone never
  force a mode change.
- Set program.planGeneration to a new unique value.
- Resolve every blocker/major in both replanFindings and relatedFindings.
- For every classAnalyses entry, inspect the whole checked set and repair the
  root cause across every affected subject. Do not fix only the example that
  triggered the report.
- Reconcile EVERY checkedSubjects member, including canonical copies in the
  program document, manifest success criteria, and workstreams[].scope. A
  member that needs no edit still requires an already-correct disposition with
  source or artifact evidence. Merely mentioning its name in prose is not a
  disposition. Every affectedSubjects member must be fixed.
- Resolve conditional members ("if one exists", "only if present") against
  repository reality before putting them in a set that tests assert equal.
- Write a concise fenced \`summary\` block ending with REPLAN_COMPLETE.
- Also return one fenced JSON object with resolutionProofs. The pipeline
  validates this structure against every classAnalyses.checkedSubjects member
  and rejects the transaction when any member lacks a disposition. Quote each
  checked subject as written in the report (matching tolerates case and
  punctuation differences, nothing more). A subject whose dispositions are all
  already-correct may use an empty changedPaths array; never invent an edit:
  { "resolutionProofs": [{ "subject": "SC-03", "changedPaths": ["docs/programs/x-program.md"], "dispositions": [{ "subject": "audit", "disposition": "fixed", "evidence": [{ "path": "docs/programs/x-program.md", "detail": "criterion now matches the audit signature" }] }, { "subject": "surface bind", "disposition": "already-correct", "evidence": [{ "path": "src/commands/surface-bind.ts:40", "detail": "takes no direction argument" }] }], "completenessBasis": "complete command list in SC-03" }] }

${previousRejection ? `Your previous attempt was rejected and rolled back. Address every
item in this rejection before editing again: ${previousRejection}\n` : ""}
${priorCycles ? `Earlier replan cycles on this program (from program memory — a fresh
report starts a new cycle, so this is your only view of what previous cycles
tried and why they were accepted or rejected; do not repeat a rejected
approach):\n${priorCycles}\n` : ""}
Replan report:
---
${report}
---
Current program document:
---
${program}
---
Current manifest:
---
${manifest}
---`;
}

type ResolutionProof = ReplanResolutionProof;
type SubjectDisposition = ResolutionProof["dispositions"][number];

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseResolutionProofs(value: unknown): ResolutionProof[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.subject !== "string" || record.subject.trim() === "" ||
      typeof record.completenessBasis !== "string" || record.completenessBasis.trim() === ""
    ) return [];
    const dispositions = Array.isArray(record.dispositions)
      ? record.dispositions.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const disposition = entry as Record<string, unknown>;
          if (
            typeof disposition.subject !== "string" || disposition.subject.trim() === "" ||
            (disposition.disposition !== "fixed" && disposition.disposition !== "already-correct") ||
            !Array.isArray(disposition.evidence)
          ) return [];
          const evidence = disposition.evidence.flatMap((raw) => {
            if (typeof raw !== "object" || raw === null) return [];
            const candidate = raw as Record<string, unknown>;
            return typeof candidate.path === "string" && candidate.path.trim() !== "" &&
              typeof candidate.detail === "string" && candidate.detail.trim() !== ""
              ? [{ path: candidate.path.trim(), detail: candidate.detail.trim() }]
              : [];
          });
          // A disposition with empty evidence is kept, not dropped: dropping
          // it here made validation report the subject as "missing", blaming
          // the wrong defect and burning a retry on misleading feedback.
          return [{
            subject: disposition.subject.trim(),
            disposition: disposition.disposition as SubjectDisposition["disposition"],
            evidence,
          }];
        })
      : [];
    return [{
      subject: record.subject.trim(),
      changedPaths: strings(record.changedPaths),
      dispositions,
      completenessBasis: record.completenessBasis.trim(),
    }];
  });
}

/**
 * The gate rejects only semantic failures. Subjects are matched by
 * {@link normalizeSubject}, never by exact string equality — the checked
 * subjects were authored by a different model, and a proof must not fail
 * because the replanner normalized case or punctuation. Surplus proofs and
 * dispositions beyond the obligations are ignored, not rejected: extra rigor
 * is not a defect, and rejecting the whole transaction over it burned
 * attempts on bookkeeping.
 */
function validateResolutionProofs(
  proofs: ResolutionProof[],
  report: Partial<ReplanReport>,
  allowedChangedPaths: string[],
): { errors: string[]; failedSubjects: string[] } {
  const obligations = proofObligationSubjects(report);
  const analyses = new Map(
    (report.classAnalyses ?? []).map((analysis) => [normalizeSubject(analysis.subject), analysis]),
  );
  const byKey = new Map<string, ResolutionProof[]>();
  for (const proof of proofs) {
    const key = normalizeSubject(proof.subject);
    byKey.set(key, [...(byKey.get(key) ?? []), proof]);
  }
  const errors: string[] = [];
  const failed = new Set<string>();
  for (const subject of obligations) {
    const matches = byKey.get(normalizeSubject(subject)) ?? [];
    if (matches.length !== 1) {
      errors.push(`${subject}: expected exactly one resolution proof, received ${matches.length}`);
      failed.add(subject);
      continue;
    }
    const proof = matches[0]!;
    const invalidPaths = proof.changedPaths.filter((path) => !allowedChangedPaths.includes(path));
    if (invalidPaths.length > 0) {
      errors.push(`${subject}: changedPaths must name only the program document or manifest (invalid: ${invalidPaths.join(", ")})`);
      failed.add(subject);
    }
    const analysis = analyses.get(normalizeSubject(subject));
    // A subject whose every disposition is already-correct legitimately has
    // no changed paths; demanding one forced the replanner to fabricate an
    // edit or fail. Anything else must name what it edited.
    const requiresEdit =
      !analysis ||
      proof.dispositions.length === 0 ||
      proof.dispositions.some(({ disposition }) => disposition === "fixed");
    if (requiresEdit && proof.changedPaths.length === 0) {
      errors.push(`${subject}: changedPaths must name the edited program document or manifest`);
      failed.add(subject);
    }
    if (!analysis) continue;
    const dispositions = new Map<string, SubjectDisposition[]>();
    for (const disposition of proof.dispositions) {
      const key = normalizeSubject(disposition.subject);
      dispositions.set(key, [...(dispositions.get(key) ?? []), disposition]);
    }
    const forSubject = (item: string): SubjectDisposition[] =>
      dispositions.get(normalizeSubject(item)) ?? [];
    const missing = analysis.checkedSubjects.filter((item) => forSubject(item).length !== 1);
    if (missing.length > 0) {
      errors.push(`${subject}: dispositions must cover every checked subject exactly once (missing/duplicate: ${missing.join(", ")})`);
      failed.add(subject);
    }
    const unproven = analysis.checkedSubjects.filter((item) => {
      const match = forSubject(item);
      return match.length === 1 && match[0]!.evidence.length === 0;
    });
    if (unproven.length > 0) {
      errors.push(`${subject}: dispositions lack evidence entries (path and detail) for: ${unproven.join(", ")}`);
      failed.add(subject);
    }
    const notFixed = analysis.affectedSubjects.filter(
      (item) => forSubject(item)[0]?.disposition !== "fixed",
    );
    if (notFixed.length > 0) {
      errors.push(`${subject}: affected subjects must be dispositioned fixed: ${notFixed.join(", ")}`);
      failed.add(subject);
    }
  }
  return { errors, failedSubjects: [...failed] };
}

function proofObligationSubjects(report: Partial<ReplanReport>): string[] {
  return [...new Set([
    ...(report.replanFindings ?? []).map(({ subject }) => subject),
    ...(report.relatedFindings ?? [])
      .filter(({ severity }) => severity === "blocker" || severity === "major")
      .map(({ subject }) => subject),
    ...(report.classAnalyses ?? []).map(({ subject }) => subject),
  ])];
}

export async function replanProgram(options: ReplanProgramOptions): Promise<ReplanProgramResult> {
  const root = resolve(options.cwd);
  const config: PipelineConfig = await loadPipelineConfig(root);
  const agent = resolveReplannerAgent(config);
  if (!agent) return { result: "ABORTED", reason: "No replanner agent is configured.", changedPaths: [] };
  const reportPath = replanReportPath(root, options.programId);
  const manifestPath = join(root, "docs", "programs", `${options.programId}-manifest.json`);
  const programPath = join(root, "docs", "programs", `${options.programId}-program.md`);
  const [initialReport, beforeManifest, beforeProgram] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(programPath, "utf8"),
  ]);
  const parsedReport = JSON.parse(initialReport) as Partial<ReplanReport>;
  if (parsedReport.outcome === "human-required") {
    return {
      result: "ABORTED",
      reason: `The replan report requires a human requirements decision; automatic replanning is blocked. Run /plan-program ${options.programId} to present the decision and record the user's answer: ${parsedReport.humanDecisionReason ?? "see humanDecisionReason in the report"}`,
      changedPaths: [],
    };
  }
  if (typeof parsedReport.inputHash === "string" && /^[a-f0-9]{64}$/u.test(parsedReport.inputHash)) {
    const currentHash = await replanInputHash(root, options.programId, config);
    if (currentHash !== parsedReport.inputHash) {
      return {
        result: "ABORTED",
        reason: "The replan report is stale: canonical planning inputs changed after the report was generated. Re-run plan-audit or converge before replanning.",
        changedPaths: [],
      };
    }
  }
  const runner = options.agentRunner ?? defaultAgentRunner;
  const progress = options.onProgress ?? (() => {});
  const now = options.now ?? (() => new Date());
  const label = describeAgent(agent);
  progress(`replanner: ${label}`);
  const portableProgram = `docs/programs/${options.programId}-program.md`;
  const portableManifest = `docs/programs/${options.programId}-manifest.json`;
  let previousRejection: string | undefined;

  // Program memory carries replan history across cycles: each new report
  // starts with an empty attemptHistory, so without this a third cycle knows
  // nothing about the first. Failures degrade to a warning, never a block.
  const replanRunId = `replan-${now().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  let priorCycles: string | undefined;
  try {
    const memory = await readProgramMemory(root, options.programId);
    const sections: string[] = [];
    const attempts = memory.attempts["replan"] ?? [];
    if (attempts.length > 0) {
      sections.push(
        "Replan attempts:",
        ...attempts.map(
          (record) =>
            `- ${record.at} attempt ${record.attempt} (${record.runId}): ${record.outcome}${record.reason ? ` — ${record.reason}` : ""}`,
        ),
      );
    }
    if (memory.diagnoses.length > 0) {
      sections.push(
        "Stage diagnoses:",
        ...memory.diagnoses.map(
          (diagnosis) =>
            `- ${diagnosis.at} ${diagnosis.stage} (${diagnosis.outcome}): ${diagnosis.reason}${diagnosis.detail ? ` [${diagnosis.detail}]` : ""}`,
        ),
      );
    }
    const criteria = Object.entries(memory.criteria);
    if (criteria.length > 0) {
      sections.push(
        "Latest plan-audit verdict per success criterion:",
        ...criteria.map(
          ([criterionId, verdict]) =>
            `- ${criterionId}: ${verdict.status} — ${verdict.reason}`,
        ),
      );
    }
    const humanDecided = Object.values(memory.findings).filter(
      (entry) => entry.humanDecision !== undefined,
    );
    if (humanDecided.length > 0) {
      sections.push(
        "Human decisions (authoritative; do not undo them):",
        ...humanDecided.map(
          (entry) =>
            `- ${entry.finding.subject}: ${entry.humanDecision?.decision} — ${entry.humanDecision?.rationale}`,
        ),
      );
    }
    if (sections.length > 0) priorCycles = sections.join("\n");
  } catch (error) {
    progress(
      `WARNING: could not read program memory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const recordAttemptMemory = async (
    attempt: number,
    outcome: "failed" | "succeeded",
    reason: string,
  ): Promise<void> => {
    try {
      await appendMemoryEvents(root, options.programId, [
        {
          kind: "attempt-recorded",
          unit: "replan",
          attempt,
          outcome,
          reason,
          at: now().toISOString(),
          runId: replanRunId,
        },
      ]);
    } catch (error) {
      progress(
        `WARNING: could not write program memory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const reject = async (
    attempt: number,
    reportBeforeAttempt: string,
    reason: string,
    failedSubjects: string[],
    resolutionProofs: ResolutionProof[],
  ): Promise<void> => {
    await Promise.all([
      atomicWriteText(programPath, beforeProgram),
      atomicWriteText(manifestPath, beforeManifest),
      atomicWriteText(reportPath, reportBeforeAttempt),
    ]);
    await recordReplanAttempt(reportPath, {
      attemptedAt: now().toISOString(),
      attempt,
      agent: label,
      outcome: "rejected",
      reason,
      failedSubjects,
      artifactsLeftOnDisk: false,
      ...(resolutionProofs.length > 0 ? { resolutionProofs } : {}),
    });
    progress(`replanner attempt ${attempt}/2 rejected and rolled back: ${reason}`);
    await recordAttemptMemory(attempt, "failed", reason);
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reportBeforeAttempt = await readFile(reportPath, "utf8");
    progress(`replanner attempt ${attempt}/2`);
    const result = await runner({
      command: agent.command,
      args: agent.args,
      prompt: brief(
        options.programId,
        reportBeforeAttempt,
        beforeProgram,
        beforeManifest,
        previousRejection,
        priorCycles,
      ),
      promptMode: agent.promptMode,
      cwd: root,
    });

    let attemptProofs: ResolutionProof[] = [];
    let rejection: { reason: string; failedSubjects: string[] } | undefined;
    if (result.inputError || result.exitCode !== 0) {
      rejection = {
        reason: `Replanner failed: ${result.inputError ?? result.output.slice(-1000)}`,
        failedSubjects: [],
      };
    } else if (!/REPLAN_COMPLETE/u.test(result.output)) {
      rejection = {
        reason: "Replanner did not return the required REPLAN_COMPLETE contract.",
        failedSubjects: [],
      };
    }

    const proofBlock = rejection ? undefined : extractJson(
      result.output,
      (value) => hasArrayKey(value, "resolutionProofs"),
    );
    if (!rejection && (typeof proofBlock !== "object" || proofBlock === null)) {
      const failedSubjects = proofObligationSubjects(parsedReport);
      rejection = {
        reason: `Replanner returned no resolutionProofs contract for: ${failedSubjects.join(", ") || "unknown subjects"}.`,
        failedSubjects,
      };
    }
    if (!rejection) {
      attemptProofs = parseResolutionProofs(
        (proofBlock as { resolutionProofs?: unknown }).resolutionProofs,
      );
      const validated = validateResolutionProofs(
        attemptProofs,
        parsedReport,
        [portableProgram, portableManifest],
      );
      if (validated.errors.length > 0) {
        rejection = {
          reason: `Replanner resolution proof failed: ${validated.errors.join(" | ")}.`,
          failedSubjects: validated.failedSubjects,
        };
      }
    }

    let afterManifest = "";
    let afterProgram = "";
    let parsed: { program?: { planGeneration?: unknown } } | undefined;
    if (!rejection) {
      try {
        [afterManifest, afterProgram] = await Promise.all([
          readFile(manifestPath, "utf8"),
          readFile(programPath, "utf8"),
        ]);
        parsed = JSON.parse(afterManifest) as { program?: { planGeneration?: unknown } };
      } catch (error) {
        rejection = {
          reason: `Replanner left unreadable plan artifacts: ${error instanceof Error ? error.message : String(error)}`,
          failedSubjects: [],
        };
      }
    }
    if (!rejection && !criteriaChangeAllowed(beforeManifest, afterManifest, parsedReport.criteriaPatches ?? [])) {
      rejection = {
        reason: "Replanner changed success criteria; automatic replanning is blocked. A human requirements decision is required.",
        failedSubjects: ["success criteria"],
      };
    }
    if (!rejection && afterManifest === beforeManifest && afterProgram === beforeProgram) {
      rejection = {
        reason: "Replanner made no changes to the program document or manifest.",
        failedSubjects: [],
      };
    }

    if (rejection) {
      await reject(
        attempt,
        reportBeforeAttempt,
        rejection.reason,
        rejection.failedSubjects,
        attemptProofs,
      );
      previousRejection = rejection.reason;
      if (attempt < 2 && !result.inputError) continue;
      return {
        result: "FAILED",
        reason: rejection.reason,
        agent: label,
        changedPaths: [],
      };
    }

    let generation = typeof parsed?.program?.planGeneration === "string"
      ? parsed.program.planGeneration
      : "";
    const beforeParsed = JSON.parse(beforeManifest) as { program?: { planGeneration?: unknown } };
    const beforeGeneration = typeof beforeParsed.program?.planGeneration === "string"
      ? beforeParsed.program.planGeneration
      : "";
    if (!generation || generation === beforeGeneration) {
      parsed!.program = {
        ...(parsed!.program ?? {}),
        planGeneration: `auto-${now().toISOString()}-${randomUUID().slice(0, 8)}`,
      };
      generation = parsed!.program.planGeneration as string;
      await atomicWriteText(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    const changedPaths = [
      ...(afterProgram === beforeProgram ? [] : [programPath]),
      ...((await readFile(manifestPath, "utf8")) === beforeManifest ? [] : [manifestPath]),
    ];
    // The report is pipeline-owned. Discard any accidental agent edit before
    // recording the accepted attempt.
    await atomicWriteText(reportPath, reportBeforeAttempt);
    await recordReplanAttempt(reportPath, {
      attemptedAt: now().toISOString(),
      attempt,
      agent: label,
      outcome: "accepted",
      reason: "Accepted after transactional artifact and resolution-proof validation.",
      failedSubjects: [],
      artifactsLeftOnDisk: true,
      resolutionProofs: attemptProofs,
    });
    const summary = resolveSummary(result.output);
    // The replanner's own account of how it restructured the plan is the one
    // rationale worth keeping; the boilerplate acceptance reason is not.
    await recordAttemptMemory(
      attempt,
      "succeeded",
      summary.text || "plan artifacts updated",
    );
    progress(`replanner complete: ${summary.text || "plan artifacts updated"}`);
    return { result: "COMPLETE", agent: label, generation, changedPaths };
  }

  return { result: "FAILED", reason: "Replanner exhausted its attempt budget.", agent: label, changedPaths: [] };
}
