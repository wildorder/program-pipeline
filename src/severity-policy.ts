import type { Evidence, Finding, Severity } from "./findings.js";

/**
 * Deterministic severity policy.
 *
 * The rule is **cause-required**: a finding keeps the severity its author
 * assigned only when it cites a cause that can be located — a file and line
 * range, or a named concern. A finding whose entire evidentiary basis is a
 * measurement ("this spec is 800 lines", "this workstream touches 14 files")
 * is downgraded to `advisory`, which never fails the gate and never keeps the
 * convergence loop running.
 *
 * The point is the *opposite* of suppression. Length and file count are
 * symptoms, never defects in themselves, so the old approach — forbidding the
 * validator from raising them at all — destroyed the signal at the source and
 * made a tight spec indistinguishable from a bloated one. Under this policy
 * the validator is free to say a spec is too long with as much force as it
 * likes; it simply has to say *why*. "WS-04 bundles auth and telemetry, split
 * at step 12" and "lines 210-340 are verbatim from the program doc" both name
 * a cause, so both keep full severity and stay actionable. Only the bare
 * measurement gets set aside.
 */

const DOWNGRADE_REASON =
  "measurement-only evidence: names a symptom (line or file count) without a locatable cause";

export function citesCause(evidence: readonly Evidence[]): boolean {
  return evidence.some(
    (item) => item.kind === "location" || item.kind === "concern",
  );
}

/** Findings that name no cause can never exceed this. */
const CAPPED: Severity = "advisory";

export function applySeverityPolicy(findings: readonly Finding[]): Finding[] {
  return findings.map((finding) => {
    if (finding.severity === CAPPED) return finding;
    if (citesCause(finding.evidence)) return finding;
    return {
      ...finding,
      severity: CAPPED,
      downgradedFrom: finding.severity,
      downgradeReason: DOWNGRADE_REASON,
    };
  });
}

export interface PolicySummary {
  downgraded: Array<{
    subject: string;
    workstreamId?: string;
    from: Severity;
    reason: string;
  }>;
}

/**
 * Downgrades are reported, never silent — a validator whose finding was set
 * aside should be able to see that it happened and supply the missing cause
 * on the next round.
 */
export function summarizePolicy(findings: readonly Finding[]): PolicySummary {
  return {
    downgraded: findings
      .filter((finding) => finding.downgradedFrom !== undefined)
      .map((finding) => ({
        subject: finding.subject,
        ...(finding.workstreamId === undefined
          ? {}
          : { workstreamId: finding.workstreamId }),
        from: finding.downgradedFrom as Severity,
        reason: finding.downgradeReason ?? DOWNGRADE_REASON,
      })),
  };
}
