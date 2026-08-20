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
import {
  captureWorktree,
  restoreWorktree,
  type WorktreeCapture,
} from "./worktree-guard.js";
import {
  buildProofObligations,
  type ProofObligation,
  type ReplanReport,
  type ReplanResolutionProof,
} from "./replan-report.js";

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

function renderObligations(obligations: ProofObligation[]): string {
  if (obligations.length === 0) return "(none)";
  return obligations
    .map((obligation) => [
      `- ${obligation.id}: ${obligation.subject}`,
      ...obligation.members.map(
        (member) => `  - ${member.id}${member.affected ? " [affected — must be fixed]" : ""}: ${member.text}`,
      ),
    ].join("\n"))
    .join("\n");
}

function brief(
  programId: string,
  report: string,
  program: string,
  manifest: string,
  obligations: ProofObligation[],
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
- Reconcile EVERY checkedSubjects member. The manifest is the single source
  of truth for success criteria, workstreams, dependencies, and scope; when a
  member exists because the program document restates manifest data, resolve
  it by replacing the restatement with an SC-xx/WS-xx reference, never by
  synchronizing two copies. A member that needs no edit still requires an
  already-correct disposition with source or artifact evidence. Merely
  mentioning its name in prose is not a disposition. Every affectedSubjects
  member must be fixed.
- Resolve conditional members ("if one exists", "only if present") against
  repository reality before putting them in a set that tests assert equal.
- Write a concise fenced \`summary\` block ending with REPLAN_COMPLETE.
- Also return one fenced JSON object with resolutionProofs. The report's
  proofObligations array assigns an id to every obligation ("P1") and to every
  checked-subject member ("P1.2"). Reference those ids — one proof per
  obligation id, one disposition per member id; never re-type the prose. The
  pipeline rejects the transaction when any member id lacks a disposition, a
  disposition lacks evidence, or an affected member is not "fixed". A proof
  whose dispositions are all already-correct may use an empty changedPaths
  array; never invent an edit:
  { "resolutionProofs": [{ "obligation": "P1", "changedPaths": ["docs/programs/x-program.md"], "dispositions": [{ "member": "P1.1", "disposition": "fixed", "evidence": [{ "path": "docs/programs/x-program.md", "detail": "criterion now matches the audit signature" }] }, { "member": "P1.2", "disposition": "already-correct", "evidence": [{ "path": "src/commands/surface-bind.ts:40", "detail": "takes no direction argument" }] }], "completenessBasis": "complete command list in SC-03" }] }

${previousRejection ? `Your previous attempt was rejected and rolled back. Address every
item in this rejection before editing again: ${previousRejection}\n` : ""}
${priorCycles ? `Earlier replan cycles on this program (from program memory — a fresh
report starts a new cycle, so this is your only view of what previous cycles
tried and why they were accepted or rejected; do not repeat a rejected
approach):\n${priorCycles}\n` : ""}
Proof obligations (reference exactly these ids in resolutionProofs):
${renderObligations(obligations)}

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
    // "obligation"/"member" carry pipeline-minted IDs; "subject" is the
    // legacy prose reference. Either resolves during validation.
    const subjectRef = typeof record.obligation === "string" && record.obligation.trim() !== ""
      ? record.obligation
      : record.subject;
    if (
      typeof subjectRef !== "string" || subjectRef.trim() === "" ||
      typeof record.completenessBasis !== "string" || record.completenessBasis.trim() === ""
    ) return [];
    const dispositions = Array.isArray(record.dispositions)
      ? record.dispositions.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const disposition = entry as Record<string, unknown>;
          const memberRef = typeof disposition.member === "string" && disposition.member.trim() !== ""
            ? disposition.member
            : disposition.subject;
          if (
            typeof memberRef !== "string" || memberRef.trim() === "" ||
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
            subject: memberRef.trim(),
            disposition: disposition.disposition as SubjectDisposition["disposition"],
            evidence,
          }];
        })
      : [];
    return [{
      subject: subjectRef.trim(),
      changedPaths: strings(record.changedPaths),
      dispositions,
      completenessBasis: record.completenessBasis.trim(),
    }];
  });
}

/**
 * The gate rejects only semantic failures, and it joins model output to
 * obligations through pipeline-minted IDs, never prose equality. A proof
 * references its obligation as "P2" and each disposition its member as
 * "P2.3" — opaque tokens code minted, which is the only place exact matching
 * of model output is legitimate. Legacy prose references still resolve
 * through {@link normalizeSubject}. Surplus proofs and dispositions beyond
 * the obligations are ignored, not rejected: extra rigor is not a defect.
 */
function validateResolutionProofs(
  proofs: ResolutionProof[],
  obligations: ProofObligation[],
  allowedChangedPaths: string[],
): { errors: string[]; failedSubjects: string[] } {
  const proofsByRef = new Map<string, ResolutionProof[]>();
  for (const proof of proofs) {
    for (const key of [proof.subject, normalizeSubject(proof.subject)]) {
      proofsByRef.set(key, [...(proofsByRef.get(key) ?? []).filter((existing) => existing !== proof), proof]);
    }
  }
  const errors: string[] = [];
  const failed = new Set<string>();
  for (const obligation of obligations) {
    const matches = [...new Set([
      ...(proofsByRef.get(obligation.id) ?? []),
      ...(proofsByRef.get(normalizeSubject(obligation.subject)) ?? []),
    ])];
    const { subject } = obligation;
    if (matches.length !== 1) {
      errors.push(`${subject} (${obligation.id}): expected exactly one resolution proof, received ${matches.length}`);
      failed.add(subject);
      continue;
    }
    const proof = matches[0]!;
    const invalidPaths = proof.changedPaths.filter((path) => !allowedChangedPaths.includes(path));
    if (invalidPaths.length > 0) {
      errors.push(`${subject}: changedPaths must name only the program document or manifest (invalid: ${invalidPaths.join(", ")})`);
      failed.add(subject);
    }
    const dispositionsByRef = new Map<string, SubjectDisposition[]>();
    for (const disposition of proof.dispositions) {
      for (const key of [disposition.subject, normalizeSubject(disposition.subject)]) {
        dispositionsByRef.set(key, [
          ...(dispositionsByRef.get(key) ?? []).filter((existing) => existing !== disposition),
          disposition,
        ]);
      }
    }
    const forMember = (member: { id: string; text: string }): SubjectDisposition[] =>
      [...new Set([
        ...(dispositionsByRef.get(member.id) ?? []),
        ...(dispositionsByRef.get(normalizeSubject(member.text)) ?? []),
      ])];
    // A subject whose every disposition is already-correct legitimately has
    // no changed paths; demanding one forced the replanner to fabricate an
    // edit or fail. Anything else must name what it edited.
    const requiresEdit =
      obligation.members.length === 0 ||
      proof.dispositions.length === 0 ||
      obligation.members.some((member) => forMember(member)[0]?.disposition === "fixed");
    if (requiresEdit && proof.changedPaths.length === 0) {
      errors.push(`${subject}: changedPaths must name the edited program document or manifest`);
      failed.add(subject);
    }
    if (obligation.members.length === 0) continue;
    const missing = obligation.members.filter((member) => forMember(member).length !== 1);
    if (missing.length > 0) {
      errors.push(`${subject}: dispositions must cover every checked subject exactly once (missing/duplicate: ${missing.map(({ id, text }) => `${id} ${text}`).join(", ")})`);
      failed.add(subject);
    }
    const unproven = obligation.members.filter((member) => {
      const match = forMember(member);
      return match.length === 1 && match[0]!.evidence.length === 0;
    });
    if (unproven.length > 0) {
      errors.push(`${subject}: dispositions lack evidence entries (path and detail) for: ${unproven.map(({ id, text }) => `${id} ${text}`).join(", ")}`);
      failed.add(subject);
    }
    const notFixed = obligation.members.filter(
      (member) => member.affected && forMember(member)[0]?.disposition !== "fixed",
    );
    if (notFixed.length > 0) {
      errors.push(`${subject}: affected subjects must be dispositioned fixed: ${notFixed.map(({ id, text }) => `${id} ${text}`).join(", ")}`);
      failed.add(subject);
    }
  }
  return { errors, failedSubjects: [...failed] };
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
  // Reports from before schema v5 carry no roster; derive the same IDs
  // deterministically so legacy prose references still validate.
  const proofObligations = parsedReport.proofObligations?.length
    ? parsedReport.proofObligations
    : buildProofObligations(parsedReport);
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
    capture: WorktreeCapture,
  ): Promise<void> => {
    // Restore the WHOLE worktree, not just the plan artifacts: the replanner
    // is a full agent and a rejected attempt may have edited out-of-scope
    // files or littered temp scripts. "Rolled back" must mean rolled back.
    const cleanup = await restoreWorktree(root, capture);
    if (cleanup.restored && (cleanup.drifted.length > 0 || cleanup.removed.length > 0)) {
      progress(
        `replanner attempt ${attempt}/2 worktree restored: ${cleanup.drifted.length} tracked file(s) reverted${
          cleanup.removed.length > 0 ? `, ${cleanup.removed.length} stray file(s) removed (${cleanup.removed.join(", ")})` : ""
        }`,
      );
    }
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
    const capture = await captureWorktree(root);
    if (!capture.available && attempt === 1) {
      progress(
        "WARNING: git snapshot unavailable (not a git repository, or git failed); a rejected attempt can only restore the program document and manifest, not other files the replanner may touch.",
      );
    }
    progress(`replanner attempt ${attempt}/2`);
    const result = await runner({
      command: agent.command,
      args: agent.args,
      prompt: brief(
        options.programId,
        reportBeforeAttempt,
        beforeProgram,
        beforeManifest,
        proofObligations,
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
      const failedSubjects = proofObligations.map(({ subject }) => subject);
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
        proofObligations,
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
        capture,
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

    // Accepted attempts get sanitized too: only the plan artifacts may keep
    // the replanner's edits. Everything else — out-of-scope edits, stray
    // temp scripts — is reverted or removed so acceptance never smuggles
    // side effects into the repository.
    const sanitized = await restoreWorktree(root, capture, [programPath, manifestPath, reportPath]);
    if (sanitized.restored && (sanitized.drifted.length > 0 || sanitized.removed.length > 0)) {
      progress(
        `replanner made out-of-scope changes; reverted ${sanitized.drifted.length} tracked file(s) (${sanitized.drifted.join(", ")})${
          sanitized.removed.length > 0 ? ` and removed ${sanitized.removed.length} stray file(s) (${sanitized.removed.join(", ")})` : ""
        }`,
      );
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
