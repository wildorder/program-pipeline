import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PACKAGE_ROOT } from "./package-assets.js";

export const WORKFLOWS = [
  "init-project",
  "plan-program",
  "author-workstreams",
  "validate-workstreams",
  "review-program",
  "build-program",
  "update-as-built",
] as const;

export type Workflow = (typeof WORKFLOWS)[number];
export type SkillTarget = "cursor" | "claude" | "openclaw";

export interface InstallSkillsOptions {
  cwd: string;
  targets: SkillTarget[];
  force?: boolean;
}

export interface InstallSkillsResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
}

const MARKER_PATTERN = /<!-- program-pipeline:sha256=([a-f0-9]{64}) -->\n?/u;
const TARGET_ROOTS: Record<SkillTarget, string> = {
  cursor: join(".cursor", "skills"),
  claude: join(".claude", "skills"),
  openclaw: "skills",
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalize(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function digest(content: string): string {
  return createHash("sha256").update(normalize(content)).digest("hex");
}

function withMarker(source: string): string {
  const normalized = normalize(source);
  const marker = `<!-- program-pipeline:sha256=${digest(normalized)} -->\n`;
  const frontmatterEnd = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || frontmatterEnd < 0) {
    throw new Error("Skill must contain YAML frontmatter.");
  }
  const insertAt = frontmatterEnd + 5;
  return `${normalized.slice(0, insertAt)}${marker}${normalized.slice(insertAt)}`;
}

function generatedFileIsUnmodified(content: string): boolean {
  const normalized = normalize(content);
  const marker = normalized.match(MARKER_PATTERN);
  if (!marker?.[1]) return false;
  const withoutMarker = normalized.replace(MARKER_PATTERN, "");
  return digest(withoutMarker) === marker[1];
}

export function parseTargets(value: string): SkillTarget[] {
  const values = value
    .split(",")
    .map((target) => target.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter(
    (target) => !Object.hasOwn(TARGET_ROOTS, target),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown target(s): ${invalid.join(", ")}. Expected cursor, claude, or openclaw.`,
    );
  }
  return [...new Set(values)] as SkillTarget[];
}

export async function installSkills(
  input: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const root = resolve(input.cwd);
  const result: InstallSkillsResult = {
    installed: [],
    updated: [],
    skipped: [],
    conflicts: [],
  };

  for (const target of input.targets) {
    for (const workflow of WORKFLOWS) {
      const relativePath = join(
        TARGET_ROOTS[target],
        workflow,
        "SKILL.md",
      );
      const destination = join(root, relativePath);
      const source = await readFile(
        join(PACKAGE_ROOT, "skills", workflow, "SKILL.md"),
        "utf8",
      );
      const desired = withMarker(source);

      if (!(await exists(destination))) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, desired, "utf8");
        result.installed.push(relativePath);
        continue;
      }

      const current = await readFile(destination, "utf8");
      if (normalize(current) === desired) {
        result.skipped.push(relativePath);
      } else if (input.force || generatedFileIsUnmodified(current)) {
        await writeFile(destination, desired, "utf8");
        result.updated.push(relativePath);
      } else {
        result.conflicts.push(relativePath);
      }
    }
  }

  return result;
}

export async function doctor(): Promise<string[]> {
  const problems: string[] = [];
  for (const workflow of WORKFLOWS) {
    const path = join(PACKAGE_ROOT, "skills", workflow, "SKILL.md");
    if (!(await exists(path))) problems.push(`Missing packaged skill: ${workflow}`);
  }
  for (const template of [
    "vision.md",
    "AGENTS.md",
    "CLAUDE.md",
    "build-product.ps1",
  ]) {
    if (!(await exists(join(PACKAGE_ROOT, "templates", template)))) {
      problems.push(`Missing packaged template: ${template}`);
    }
  }
  for (const schema of [
    "manifest.schema.json",
    "pipeline-config.schema.json",
  ]) {
    if (!(await exists(join(PACKAGE_ROOT, "schemas", schema)))) {
      problems.push(`Missing packaged schema: ${schema}`);
    }
  }
  return problems;
}
