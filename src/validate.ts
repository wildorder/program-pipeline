import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { findCycles } from "./graph.js";
import { PACKAGE_ROOT } from "./package-assets.js";

export type Severity = "blocker" | "major" | "minor";

/**
 * The deterministic workstream-spec contract. The authoring and validation
 * skills describe this format in prose; this validator owns it. Keep the two
 * aligned by treating these values as canonical.
 */
export const SPEC_CONTRACT = {
  sections: {
    traceability: "Traceability",
    filesTouched: "Files Touched",
    tests: "Tests",
    acceptanceCriteria: "Acceptance Criteria",
  },
  successCriterionIdPattern: "SC-\\d{2,}",
  workstreamIdPattern: "WS-\\d{2,}",
  fileAnnotationPattern: "\\((?:NEW|MODIFY)\\)",
} as const;

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  workstreamId?: string;
  file?: string;
}

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
          code: "manifest-missing",
          message: `Manifest not found: docs/programs/${programId}-manifest.json`,
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
          code: "manifest-schema",
          message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
          file: manifestPath,
        })),
      };
    }
    return { manifest: raw, findings: [] };
  } catch (error) {
    return {
      findings: [
        {
          severity: "blocker",
          code: "manifest-invalid",
          message: error instanceof Error ? error.message : String(error),
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
      code: "program-id-mismatch",
      message: `Manifest declares ${manifest.program.id} but the requested program is ${programId}.`,
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
          code,
          message: `Duplicate ${label}: ${value}.`,
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
          code: "dependency-unknown",
          message: `Unknown dependency ${dependency}.`,
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
        code: "task-path-unsafe",
        message: `Task file escapes the project root: ${workstream.taskFile}`,
        workstreamId: workstream.id,
      });
      continue;
    }

    const taskPath = resolve(root, workstream.taskFile);
    if (!(await exists(taskPath))) {
      findings.push({
        severity: "blocker",
        code: "spec-missing",
        message: `Spec not found: ${workstream.taskFile}`,
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
        code: "traceability-missing",
        message: "Traceability must reference at least one success criterion.",
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
          code: "traceability-unknown",
          message: `Unknown success criterion ${criterionId}.`,
          workstreamId: workstream.id,
          file: taskPath,
        });
      }
    }

    const filesTouched = specSection(
      markdown,
      SPEC_CONTRACT.sections.filesTouched,
    );
    const fileLines =
      filesTouched?.split(/\r?\n/u).filter((line) => /[`/\\][^`]*`/u.test(line)) ??
      [];
    const annotation = new RegExp(SPEC_CONTRACT.fileAnnotationPattern, "u");
    if (
      !filesTouched ||
      fileLines.length === 0 ||
      fileLines.some((line) => !annotation.test(line))
    ) {
      findings.push({
        severity: "blocker",
        code: "files-annotation-missing",
        message: "Every listed file must be annotated (NEW) or (MODIFY).",
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
          code: "section-missing",
          message: `Missing or empty ${requiredSection} section.`,
          workstreamId: workstream.id,
          file: taskPath,
        });
      }
    }
  }

  for (const cycle of findCycles(manifest.workstreams)) {
    findings.push({
      severity: "blocker",
      code: "dependency-cycle",
      message: `Dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  for (const [criterionId, workstreamIds] of coverage) {
    if (workstreamIds.length === 0) {
      findings.push({
        severity: "blocker",
        code: "criterion-uncovered",
        message: `${criterionId} has no workstream coverage.`,
      });
    }
  }

  for (const manifestPackage of manifest.packages ?? []) {
    if (!touchedPackages.has(manifestPackage.name)) {
      findings.push({
        severity: "major",
        code: "package-untouched",
        message: `Manifest package ${manifestPackage.name} is not assigned to a workstream.`,
      });
    }
  }

  const failed = findings.some(
    ({ severity }) => severity === "blocker" || (strict && severity === "major"),
  );
  return {
    programId: manifest.program.id,
    result: failed ? "FAILED" : "PASSED",
    strict,
    findings,
    coverage: [...coverage].map(([successCriterionId, workstreamIds]) => ({
      successCriterionId,
      workstreamIds,
    })),
  };
}
