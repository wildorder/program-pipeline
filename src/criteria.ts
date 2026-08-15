import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SPEC_CONTRACT, specSection } from "./validate.js";

/**
 * The one human gate left in the pipeline, and the only one worth having.
 *
 * Everything else the pipeline checks is fact-shaped: a dependency either
 * exists or it does not, a spec section is either present or absent, a verify
 * command either exits zero or it does not. Those settle themselves.
 * Acceptance criteria are different — they encode what "done" means, which is
 * a scoping decision, and no amount of model review substitutes for the
 * person who owns the outcome saying "yes, that is what I asked for".
 *
 * Two design choices follow from that. It is **batched**: every criterion in
 * the program is pulled into one document, reviewed in one pass, rather than
 * asked about workstream by workstream. And approval is **keyed to a content
 * hash** of the criteria themselves, so editing a criterion after approval
 * lapses that approval automatically instead of leaving a stale sign-off
 * attached to text nobody agreed to.
 *
 * The gate sits after convergence, not before it: the loop edits specs, and
 * approving criteria that a later round then rewrites would mean re-approving
 * after every round.
 */

export interface WorkstreamCriteria {
  id: string;
  name: string;
  taskFile: string;
  scopeSummary?: string;
  /** Undefined when the spec has no Acceptance Criteria section. */
  criteria?: string;
}

export interface CriteriaApproval {
  hash: string;
  approvedAt: string;
}

export interface CriteriaStatus {
  programId: string;
  workstreams: WorkstreamCriteria[];
  hash: string;
  approval?: CriteriaApproval;
  /** Approval exists and still matches the criteria as they stand. */
  approved: boolean;
  /** Approval exists but the criteria changed under it. */
  lapsed: boolean;
  /** Workstreams whose spec has no Acceptance Criteria section. */
  missing: string[];
}

export type CriteriaOutcome = "APPROVED" | "REVIEW_REQUIRED" | "ABORTED";

export interface CriteriaResult {
  programId: string;
  result: CriteriaOutcome;
  reason?: string;
  documentPath?: string;
  hash?: string;
  approvedAt?: string;
  lapsed?: boolean;
  missing?: string[];
}

export interface CriteriaOptions {
  cwd: string;
  programId: string;
  /** Record approval for the criteria exactly as they stand right now. */
  approve?: boolean;
  now?: () => Date;
  onProgress?: (line: string) => void;
}

interface ManifestShape {
  workstreams?: Array<{
    id: string;
    name: string;
    taskFile: string;
    scope?: { summary?: string };
  }>;
  criteriaApproval?: CriteriaApproval;
}

/** Line endings and trailing spaces must not lapse an approval. */
function normalize(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Identity of the criteria set. Sorted by workstream id so manifest order
 * cannot change the hash, and computed from the criteria text alone — a
 * reworded goal or a new implementation step is not a change to what "done"
 * means, and must not invalidate a sign-off.
 */
export function criteriaHash(workstreams: WorkstreamCriteria[]): string {
  const parts = [...workstreams]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, criteria }) => `${id}\n${normalize(criteria ?? "")}`);
  return createHash("sha256")
    .update(parts.join("\n---\n"))
    .digest("hex")
    .slice(0, 16);
}

export function manifestPathFor(root: string, programId: string): string {
  return join(root, "docs", "programs", `${programId}-manifest.json`);
}

export function documentPathFor(root: string, programId: string): string {
  return join(root, "docs", "programs", `${programId}-criteria.md`);
}

/** Read every workstream's Acceptance Criteria section from its spec. */
export async function collectCriteria(
  root: string,
  programId: string,
): Promise<CriteriaStatus> {
  const manifest = JSON.parse(
    await readFile(manifestPathFor(root, programId), "utf8"),
  ) as ManifestShape;

  const workstreams: WorkstreamCriteria[] = [];
  for (const entry of manifest.workstreams ?? []) {
    let criteria: string | undefined;
    try {
      const markdown = await readFile(resolve(root, entry.taskFile), "utf8");
      criteria = specSection(
        markdown,
        SPEC_CONTRACT.sections.acceptanceCriteria,
      );
    } catch {
      criteria = undefined;
    }
    const summary = entry.scope?.summary?.trim();
    workstreams.push({
      id: entry.id,
      name: entry.name,
      taskFile: entry.taskFile,
      ...(summary ? { scopeSummary: summary } : {}),
      ...(criteria === undefined ? {} : { criteria }),
    });
  }

  const hash = criteriaHash(workstreams);
  const approval = manifest.criteriaApproval;
  return {
    programId,
    workstreams,
    hash,
    ...(approval ? { approval } : {}),
    approved: approval?.hash === hash,
    lapsed: approval !== undefined && approval.hash !== hash,
    missing: workstreams
      .filter(({ criteria }) => criteria === undefined)
      .map(({ id }) => id),
  };
}

export function renderCriteriaDocument(status: CriteriaStatus): string {
  const lines: string[] = [
    `# Acceptance criteria: ${status.programId}`,
    "",
    "Generated by `program-pipeline criteria`. This is the definition of done",
    "for every workstream in this program — the one thing in the pipeline",
    "worth a person's review before a build runs. Edit the criteria in the",
    "workstream specs themselves, not here; this document is regenerated.",
    "",
  ];

  if (status.approved && status.approval) {
    lines.push(
      `**Approved** ${status.approval.approvedAt} for criteria hash \`${status.hash}\`.`,
    );
  } else if (status.lapsed && status.approval) {
    lines.push(
      `**Approval lapsed.** Approved ${status.approval.approvedAt} for hash \`${status.approval.hash}\`, but the criteria have changed since; the set now hashes to \`${status.hash}\`. Re-review and approve again.`,
    );
  } else {
    lines.push(
      `**Not approved.** Criteria hash \`${status.hash}\`. Approve with \`program-pipeline criteria ${status.programId} --approve\`.`,
    );
  }
  lines.push("");

  if (status.missing.length > 0) {
    lines.push(
      `> These workstreams have no Acceptance Criteria section, so there is nothing here to approve for them: ${status.missing.join(", ")}. \`program-pipeline validate\` reports this separately.`,
      "",
    );
  }

  for (const workstream of status.workstreams) {
    lines.push(`## ${workstream.id}: ${workstream.name}`, "");
    if (workstream.scopeSummary) {
      lines.push(`_${workstream.scopeSummary}_`, "");
    }
    lines.push(
      workstream.criteria ?? "_No Acceptance Criteria section in the spec._",
      "",
      `<sub>${workstream.taskFile}</sub>`,
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function recordApproval(
  manifestPath: string,
  approval: CriteriaApproval,
): Promise<void> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  raw.criteriaApproval = approval;
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export async function reviewCriteria(
  options: CriteriaOptions,
): Promise<CriteriaResult> {
  const root = resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const progress = options.onProgress ?? ((): void => {});

  let status: CriteriaStatus;
  try {
    status = await collectCriteria(root, options.programId);
  } catch (error) {
    return {
      programId: options.programId,
      result: "ABORTED",
      reason: `Could not read the program's criteria: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (status.workstreams.length === 0) {
    return {
      programId: options.programId,
      result: "ABORTED",
      reason: `No workstreams in ${manifestPathFor(root, options.programId)}.`,
    };
  }

  const documentPath = documentPathFor(root, options.programId);
  await mkdir(dirname(documentPath), { recursive: true });

  if (options.approve) {
    const approval: CriteriaApproval = {
      hash: status.hash,
      approvedAt: now().toISOString(),
    };
    await recordApproval(manifestPathFor(root, options.programId), approval);
    status = { ...status, approval, approved: true, lapsed: false };
    await writeFile(documentPath, renderCriteriaDocument(status), "utf8");
    progress(
      `criteria approved for ${options.programId} (hash ${status.hash}); editing any criterion lapses this`,
    );
    return {
      programId: options.programId,
      result: "APPROVED",
      documentPath,
      hash: status.hash,
      approvedAt: approval.approvedAt,
      missing: status.missing,
    };
  }

  await writeFile(documentPath, renderCriteriaDocument(status), "utf8");
  progress(`criteria written to ${documentPath}`);
  if (status.missing.length > 0) {
    progress(
      `no Acceptance Criteria section in: ${status.missing.join(", ")}`,
    );
  }

  if (status.approved && status.approval) {
    progress(`already approved ${status.approval.approvedAt}`);
    return {
      programId: options.programId,
      result: "APPROVED",
      documentPath,
      hash: status.hash,
      approvedAt: status.approval.approvedAt,
      missing: status.missing,
    };
  }

  return {
    programId: options.programId,
    result: "REVIEW_REQUIRED",
    reason: status.lapsed
      ? `The criteria changed after they were approved, so the approval lapsed. Review ${documentPath} and re-approve with --approve.`
      : `Review ${documentPath} and approve with --approve once the definition of done is right.`,
    documentPath,
    hash: status.hash,
    lapsed: status.lapsed,
    missing: status.missing,
  };
}

/**
 * Gate helper for the build runner: is the current criteria set approved?
 * Returns the reason it is not, or undefined when it is.
 */
export async function criteriaGateFailure(
  root: string,
  programId: string,
): Promise<string | undefined> {
  let status: CriteriaStatus;
  try {
    status = await collectCriteria(root, programId);
  } catch (error) {
    return `Could not check acceptance-criteria approval: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (status.approved) return undefined;
  const document = documentPathFor(root, programId);
  return status.lapsed
    ? `build.requireCriteriaApproval is set and the acceptance criteria changed after they were approved. Re-review them with: program-pipeline criteria ${programId} --approve (document: ${document}).`
    : `build.requireCriteriaApproval is set and this program's acceptance criteria have not been approved. Review them with: program-pipeline criteria ${programId}, then approve with --approve (document: ${document}).`;
}
