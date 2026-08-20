import { createHash } from "node:crypto";

/**
 * `advisory` never fails a gate and never keeps the convergence loop running.
 * It is where the severity policy puts observations that name no cause.
 */
export type Severity = "blocker" | "major" | "minor" | "advisory";

export const SEVERITY_ORDER: readonly Severity[] = [
  "blocker",
  "major",
  "minor",
  "advisory",
] as const;

/**
 * A closed set, because finding identity is built from the category and the
 * subject rather than from the prose. A critic that rewords an objection must
 * not thereby create a "new" finding — that is what prevents the loop from
 * oscillating forever between rounds.
 */
export const FINDING_CATEGORIES = [
  "manifest",
  "coverage",
  "traceability",
  "dependency",
  "spec-format",
  "interface-contract",
  "test-quality",
  "acceptance-criteria",
  "redundancy",
  "scope-structure",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * Why a finding is true. The severity policy reads this and nothing else:
 * a finding supported only by `measurement` is an observation, not a defect.
 */
export type Evidence =
  | {
      kind: "location";
      file: string;
      startLine: number;
      endLine?: number;
      excerpt?: string;
    }
  | { kind: "concern"; named: string; detail?: string }
  | {
      kind: "measurement";
      metric: "lineCount" | "fileCount";
      value: number;
    };

export interface Finding {
  severity: Severity;
  category: FindingCategory;
  /** Machine code for deterministic checks; absent on model-authored findings. */
  code?: string;
  /**
   * Short, normalized noun phrase naming what the finding is about — `SC-03`,
   * `AuthToken interface`, `Tests case 4`. Identity comes from this, not from
   * `message`, so wording may change freely between rounds.
   */
  subject: string;
  message: string;
  evidence: Evidence[];
  workstreamId?: string;
  file?: string;
  /**
   * The fix is not an edit to a spec — the workstream must be split, a
   * workstream is missing, the manifest's ordering is itself wrong. Ends the
   * convergence loop immediately rather than spending further rounds
   * polishing a spec that should not exist in that shape.
   */
  requiresReplan?: boolean;
  /** Set by the policy layer when it downgrades, explaining why. */
  downgradedFrom?: Severity;
  downgradeReason?: string;
}

/** A finding carrying its fingerprint, for briefs and ledger bookkeeping. */
export type IdentifiedFinding = Finding & { id: string };

/** Proof that a model inspected a defect's whole equivalence class. */
export interface ClassAnalysis {
  subject: string;
  scope: "isolated" | "systemic";
  rootCause: string;
  affectedSubjects: string[];
  checkedSubjects: string[];
  completenessBasis: string;
}

export function identify(finding: Finding): IdentifiedFinding {
  return { ...finding, id: fingerprint(finding) };
}

const COMPOUND_CRITERION_SUBJECT = /^SC-\d+(?:\s*[/,+&]\s*SC-\d+)+$/u;

/**
 * Critics recurrently merge criteria that share a root cause into one subject
 * ("SC-05/SC-06"). The repair is a deterministic split — one subject per
 * SC-id — so it happens here rather than by burning a correction retry on a
 * transformation code can perform. A non-compound subject passes through as a
 * one-element list.
 */
export function splitCriterionSubjects(subject: string): string[] {
  const trimmed = subject.trim();
  if (!COMPOUND_CRITERION_SUBJECT.test(trimmed)) return [trimmed];
  return [...new Set(trimmed.split(/\s*[/,+&]\s*/u))];
}

/**
 * Collapse incidental spelling differences without merging distinct subjects.
 * Also the matching key wherever one model must reference subjects another
 * model authored (e.g. replan resolution proofs against critic class
 * analyses) — cross-model references must never fail on case or punctuation.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[`"'*_]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Stable identity across rounds: category + workstream + normalized subject.
 * Deliberately excludes `message`, `severity`, and line numbers — a finding
 * re-raised in different words, at a different severity, after the file has
 * shifted by a few lines is the *same* finding, and the loop must see it that
 * way to detect a round that produced nothing new.
 */
export function fingerprint(finding: Finding): string {
  const parts = [
    finding.category,
    finding.workstreamId ?? "",
    normalizeSubject(finding.subject),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function isGateFailing(finding: Finding, strict: boolean): boolean {
  return (
    finding.severity === "blocker" || (strict && finding.severity === "major")
  );
}

/** Blockers and majors are what keep the loop running; minors never do. */
export function haltsConvergence(finding: Finding): boolean {
  return finding.severity === "blocker" || finding.severity === "major";
}

export function countBySeverity(
  findings: readonly Finding[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    blocker: 0,
    major: 0,
    minor: 0,
    advisory: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function sortBySeverity(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

/** Convenience constructors keep deterministic call sites terse. */
export const at = (
  file: string,
  startLine: number,
  endLine?: number,
): Evidence => ({
  kind: "location",
  file,
  startLine,
  ...(endLine === undefined ? {} : { endLine }),
});

export const because = (named: string, detail?: string): Evidence => ({
  kind: "concern",
  named,
  ...(detail === undefined ? {} : { detail }),
});

export const measured = (
  metric: "lineCount" | "fileCount",
  value: number,
): Evidence => ({ kind: "measurement", metric, value });
