import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  because,
  isGateFailing,
  sortBySeverity,
  type Finding,
} from "./findings.js";
import { findCycles } from "./graph.js";
import { PACKAGE_ROOT } from "./package-assets.js";
import { applySeverityPolicy } from "./severity-policy.js";

export {
  FINDING_CATEGORIES,
  countBySeverity,
  fingerprint,
  sortBySeverity,
  type Evidence,
  type Finding,
  type FindingCategory,
  type Severity,
} from "./findings.js";

/**
 * The deterministic workstream-spec contract. The authoring and validation
 * skills describe this format in prose; this validator owns it. Keep the two
 * aligned by treating these values as canonical.
 */
export const SPEC_CONTRACT = {
  sections: {
    traceability: "Traceability",
    checkpointSafety: "Checkpoint Safety",
    filesTouched: "Files Touched",
    tests: "Tests",
    acceptanceCriteria: "Acceptance Criteria",
  },
  successCriterionIdPattern: "SC-\\d{2,}",
  workstreamIdPattern: "WS-\\d{2,}",
  /** A short note may follow the keyword and wrap across markdown lines. */
  fileAnnotationPattern: "\\((?:NEW|MODIFY|DELETE)\\b",
  newFileAnnotationPattern: "\\(NEW\\b[^)]*\\)",
  /** Only list items count as file entries; other lines are commentary. */
  fileEntryPattern: "^\\s*(?:[-*]|\\d+\\.)\\s",
} as const;

export interface CoverageEntry {
  successCriterionId: string;
  workstreamIds: string[];
}

export interface ValidationReport {
  programId: string;
  result: "PASSED" | "FAILED";
  strict: boolean;
  findings: Finding[];
  coverage: CoverageEntry[];
}

interface Manifest {
  program: { id: string };
  successCriteria: Array<{ id: string; description: string }>;
  packages?: Array<{ name: string; path: string }>;
  workstreams: Array<{
    id: string;
    name: string;
    taskFile: string;
    dependencies: string[];
    packages?: string[];
  }>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Extract a level-2 section's content from a workstream spec. */
export function specSection(
  markdown: string,
  heading: string,
): string | undefined {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start < 0) return undefined;
  const following = lines.slice(start + 1);
  const nextHeading = following.findIndex((line) => /^##\s+/u.test(line));
  const content = following
    .slice(0, nextHeading < 0 ? undefined : nextHeading)
    .join("\n")
    .trim();
  return content || undefined;
}

function ids(text: string | undefined, prefix: "SC" | "WS"): string[] {
  if (!text) return [];
  return [...new Set(text.match(new RegExp(`${prefix}-\\d{2,}`, "gu")) ?? [])];
}

function containsUnsafePath(root: string, candidate: string): boolean {
  const resolved = resolve(root, candidate);
  const fromRoot = relative(root, resolved);
  return fromRoot.startsWith("..") || isAbsolute(fromRoot);
}

async function readManifest(
  root: string,
  programId: string,
): Promise<{ manifest?: Manifest; findings: Finding[] }> {
  const manifestPath = join(
    root,
    "docs",
    "programs",
    `${programId}-manifest.json`,
  );
  if (!(await exists(manifestPath))) {
    return {
      findings: [
        {
          severity: "blocker",
          category: "manifest",
          code: "manifest-missing",
          subject: "manifest",
          message: `Manifest not found: docs/programs/${programId}-manifest.json`,
          evidence: [because("manifest file absent", manifestPath)],
          file: manifestPath,
        },
      ],
    };
  }

  try {
    const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const schema = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "schemas", "manifest.schema.json"), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile<Manifest>(schema);
    if (!validate(raw)) {
      return {
        findings: (validate.errors ?? []).map((error: ErrorObject) => ({
          severity: "blocker" as const,
          category: "manifest" as const,
          code: "manifest-schema",
          subject: error.instancePath || "/",
          message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
          evidence: [
            because("manifest schema violation", error.message ?? "is invalid"),
          ],
          file: manifestPath,
        })),
      };
    }
    return { manifest: raw, findings: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      findings: [
        {
          severity: "blocker",
          category: "manifest",
          code: "manifest-invalid",
          subject: "manifest",
          message: detail,
          evidence: [because("manifest could not be parsed", detail)],
          file: manifestPath,
        },
      ],
    };
  }
}

export async function validateWorkstreams(
  rootInput: string,
  programId: string,
  strict = false,
): Promise<ValidationReport> {
  const root = resolve(rootInput);
  const loaded = await readManifest(root, programId);
  const findings = [...loaded.findings];
  const coverage = new Map<string, string[]>();
  const manifest = loaded.manifest;

  if (!manifest) {
    return { programId, result: "FAILED", strict, findings, coverage: [] };
  }

  if (manifest.program.id !== programId) {
    findings.push({
      severity: "blocker",
      category: "manifest",
      code: "program-id-mismatch",
      subject: "program id",
      message: `Manifest declares ${manifest.program.id} but the requested program is ${programId}.`,
      evidence: [
        because(
          "manifest program id disagrees with the requested program",
          `${manifest.program.id} != ${programId}`,
        ),
      ],
    });
  }

  for (const [code, label, values] of [
    [
      "criterion-duplicate",
      "success criterion",
      manifest.successCriteria.map(({ id }) => id),
    ],
    [
      "workstream-duplicate",
      "workstream",
      manifest.workstreams.map(({ id }) => id),
    ],
    [
      "task-file-duplicate",
      "task file",
      manifest.workstreams.map(({ taskFile }) => taskFile),
    ],
  ] as const) {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) {
        findings.push({
          severity: code === "task-file-duplicate" ? "major" : "blocker",
          category: "manifest",
          code,
          subject: value,
          message: `Duplicate ${label}: ${value}.`,
          evidence: [because(`duplicate ${label} in the manifest`, value)],
        });
      }
      seen.add(value);
    }
  }

  for (const criterion of manifest.successCriteria) coverage.set(criterion.id, []);
  const knownIds = new Set(manifest.workstreams.map(({ id }) => id));
  const touchedPackages = new Set<string>();

  for (const workstream of manifest.workstreams) {
    for (const dependency of workstream.dependencies) {
      if (!knownIds.has(dependency)) {
        findings.push({
          severity: "blocker",
          category: "dependency",
          code: "dependency-unknown",
          subject: dependency,
          message: `Unknown dependency ${dependency}.`,
          evidence: [
            because(
              "declared dependency matches no workstream in the manifest",
              dependency,
            ),
          ],
          workstreamId: workstream.id,
        });
      }
    }
    for (const packageName of workstream.packages ?? []) {
      touchedPackages.add(packageName);
    }

    if (containsUnsafePath(root, workstream.taskFile)) {
      findings.push({
        severity: "blocker",
        category: "spec-format",
        code: "task-path-unsafe",
        subject: workstream.taskFile,
        message: `Task file escapes the project root: ${workstream.taskFile}`,
        evidence: [
          because("task file path resolves outside the project root", workstream.taskFile),
        ],
        workstreamId: workstream.id,
      });
      continue;
    }

    const taskPath = resolve(root, workstream.taskFile);
    if (!(await exists(taskPath))) {
      findings.push({
        severity: "blocker",
        category: "spec-format",
        code: "spec-missing",
        subject: workstream.taskFile,
        message: `Spec not found: ${workstream.taskFile}`,
        evidence: [
          because("manifest references a spec file that does not exist", workstream.taskFile),
        ],
        workstreamId: workstream.id,
        file: taskPath,
      });
      continue;
    }

    const markdown = await readFile(taskPath, "utf8");
    const traceability = ids(
      specSection(markdown, SPEC_CONTRACT.sections.traceability),
      "SC",
    );
    if (traceability.length === 0) {
      findings.push({
        severity: "blocker",
        category: "traceability",
        code: "traceability-missing",
        subject: "traceability section",
        message: "Traceability must reference at least one success criterion.",
        evidence: [
          because("Traceability section names no SC-xx identifier", workstream.taskFile),
        ],
        workstreamId: workstream.id,
        file: taskPath,
      });
    }
    for (const criterionId of traceability) {
      const mapped = coverage.get(criterionId);
      if (mapped) mapped.push(workstream.id);
      else {
        findings.push({
          severity: "major",
          category: "traceability",
          code: "traceability-unknown",
          subject: criterionId,
          message: `Unknown success criterion ${criterionId}.`,
          evidence: [
            because(
              "spec traces to a criterion the manifest does not define",
              criterionId,
            ),
          ],
          workstreamId: workstream.id,
          file: taskPath,
        });
      }
    }

    const filesTouched = specSection(
      markdown,
      SPEC_CONTRACT.sections.filesTouched,
    );
    const fileEntry = new RegExp(SPEC_CONTRACT.fileEntryPattern, "u");
    const fileLines =
      filesTouched
        ?.split(/\r?\n/u)
        .filter(
          (line) => fileEntry.test(line) && /[`/\\][^`]*`/u.test(line),
        ) ?? [];
    const annotation = new RegExp(SPEC_CONTRACT.fileAnnotationPattern, "u");
    if (
      !filesTouched ||
      fileLines.length === 0 ||
      fileLines.some((line) => !annotation.test(line))
    ) {
      findings.push({
        severity: "blocker",
        category: "spec-format",
        code: "files-annotation-missing",
        subject: SPEC_CONTRACT.sections.filesTouched,
        message: "Every listed file must be annotated (NEW), (MODIFY), or (DELETE).",
        evidence: [
          because(
            "a Files Touched list item lacks a (NEW), (MODIFY), or (DELETE) annotation",
            workstream.taskFile,
          ),
        ],
        workstreamId: workstream.id,
        file: taskPath,
      });
    }

    if (!specSection(markdown, SPEC_CONTRACT.sections.checkpointSafety)) {
      findings.push({
        severity: "blocker",
        category: "dependency",
        code: "checkpoint-safety-missing",
        subject: SPEC_CONTRACT.sections.checkpointSafety,
        message:
          "Missing or empty Checkpoint Safety section; the workstream must explain why all verification commands remain green before later workstreams run.",
        evidence: [
          because(
            "independently-green checkpoint safety was not specified",
            workstream.taskFile,
          ),
        ],
        workstreamId: workstream.id,
        file: taskPath,
      });
    }

    for (const requiredSection of [
      SPEC_CONTRACT.sections.tests,
      SPEC_CONTRACT.sections.acceptanceCriteria,
    ]) {
      if (!specSection(markdown, requiredSection)) {
        findings.push({
          severity: "major",
          category: "spec-format",
          code: "section-missing",
          subject: requiredSection,
          message: `Missing or empty ${requiredSection} section.`,
          evidence: [
            because(
              "required spec section is absent or empty",
              requiredSection,
            ),
          ],
          workstreamId: workstream.id,
          file: taskPath,
        });
      }
    }
  }

  for (const cycle of findCycles(manifest.workstreams)) {
    findings.push({
      severity: "blocker",
      category: "dependency",
      code: "dependency-cycle",
      subject: `cycle ${[...cycle].sort().join(" ")}`,
      message: `Dependency cycle: ${cycle.join(" -> ")}`,
      evidence: [
        because("dependency graph contains a cycle", cycle.join(" -> ")),
      ],
    });
  }

  for (const [criterionId, workstreamIds] of coverage) {
    if (workstreamIds.length === 0) {
      findings.push({
        severity: "blocker",
        category: "coverage",
        code: "criterion-uncovered",
        subject: criterionId,
        message: `${criterionId} has no workstream coverage.`,
        evidence: [
          because("no workstream traces to this success criterion", criterionId),
        ],
      });
    }
  }

  for (const manifestPackage of manifest.packages ?? []) {
    if (!touchedPackages.has(manifestPackage.name)) {
      findings.push({
        severity: "major",
        category: "coverage",
        code: "package-untouched",
        subject: manifestPackage.name,
        message: `Manifest package ${manifestPackage.name} is not assigned to a workstream.`,
        evidence: [
          because(
            "manifest package is claimed by no workstream",
            manifestPackage.name,
          ),
        ],
      });
    }
  }

  // Single choke point: severity is decided here, after every check has had
  // its say, so no caller can gate a finding out before it is even raised.
  const policed = applySeverityPolicy(findings);
  const failed = policed.some((finding) => isGateFailing(finding, strict));
  return {
    programId: manifest.program.id,
    result: failed ? "FAILED" : "PASSED",
    strict,
    findings: sortBySeverity(policed),
    coverage: [...coverage].map(([successCriterionId, workstreamIds]) => ({
      successCriterionId,
      workstreamIds,
    })),
  };
}
