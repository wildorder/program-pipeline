import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
export type SkillTarget = "cursor" | "claude" | "openclaw" | "codex" | "gemini";

export interface InstallSkillsOptions {
  cwd: string;
  targets: SkillTarget[];
  force?: boolean;
  home?: string;
}

export interface DefinitionWarning {
  workflow: Workflow;
  kind: "command" | "skill";
  scope: "project" | "user";
  target: SkillTarget;
  path: string;
  packageManaged: boolean;
}

export interface InstallSkillsResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  warnings: DefinitionWarning[];
  aborted: boolean;
}

const MARKER_PATTERN = /<!-- program-pipeline:sha256=([a-f0-9]{64}) -->\n?/u;
const TARGET_ROOTS: Record<SkillTarget, string> = {
  cursor: join(".cursor", "skills"),
  claude: join(".claude", "skills"),
  openclaw: "skills",
  // Codex discovers skills in the cross-tool .agents/skills directory.
  codex: join(".agents", "skills"),
  gemini: join(".gemini", "skills"),
};
export const ALL_TARGETS = Object.keys(TARGET_ROOTS) as SkillTarget[];
export const DEFAULT_TARGETS = ALL_TARGETS.join(",");
const COMMAND_EXTENSIONS = [".md", ".mdc", ".markdown", ".txt"] as const;

interface DefinitionRoot {
  target: SkillTarget;
  kind: "command" | "skill";
  scope: "project" | "user";
  root: string;
}

interface PlannedWrite {
  relativePath: string;
  destination: string;
  desired: string;
  action: "install" | "update" | "skip" | "conflict";
}

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
      `Unknown target(s): ${invalid.join(", ")}. Expected: ${ALL_TARGETS.join(", ")}.`,
    );
  }
  return [...new Set(values)] as SkillTarget[];
}

function definitionRoots(
  projectRoot: string,
  userHome: string,
  targets: SkillTarget[],
): DefinitionRoot[] {
  const roots: DefinitionRoot[] = [];
  if (targets.includes("cursor")) {
    roots.push(
      { target: "cursor", kind: "command", scope: "project", root: join(projectRoot, ".cursor", "commands") },
      { target: "cursor", kind: "command", scope: "user", root: join(userHome, ".cursor", "commands") },
      { target: "cursor", kind: "skill", scope: "project", root: join(projectRoot, ".cursor", "skills") },
      { target: "cursor", kind: "skill", scope: "project", root: join(projectRoot, ".agents", "skills") },
      { target: "cursor", kind: "skill", scope: "project", root: join(projectRoot, ".claude", "skills") },
      { target: "cursor", kind: "skill", scope: "user", root: join(userHome, ".cursor", "skills") },
      { target: "cursor", kind: "skill", scope: "user", root: join(userHome, ".agents", "skills") },
      { target: "cursor", kind: "skill", scope: "user", root: join(userHome, ".claude", "skills") },
    );
  }
  if (targets.includes("claude")) {
    roots.push(
      { target: "claude", kind: "command", scope: "project", root: join(projectRoot, ".claude", "commands") },
      { target: "claude", kind: "command", scope: "user", root: join(userHome, ".claude", "commands") },
      { target: "claude", kind: "skill", scope: "project", root: join(projectRoot, ".claude", "skills") },
      { target: "claude", kind: "skill", scope: "user", root: join(userHome, ".claude", "skills") },
    );
  }
  if (targets.includes("openclaw")) {
    roots.push(
      { target: "openclaw", kind: "skill", scope: "project", root: join(projectRoot, "skills") },
      { target: "openclaw", kind: "skill", scope: "user", root: join(userHome, ".openclaw", "skills") },
      { target: "openclaw", kind: "skill", scope: "user", root: join(userHome, ".openclaw", "workspace", "skills") },
    );
  }
  if (targets.includes("codex")) {
    roots.push(
      { target: "codex", kind: "skill", scope: "project", root: join(projectRoot, ".agents", "skills") },
      { target: "codex", kind: "skill", scope: "user", root: join(userHome, ".agents", "skills") },
      { target: "codex", kind: "skill", scope: "user", root: join(userHome, ".codex", "skills") },
    );
  }
  if (targets.includes("gemini")) {
    roots.push(
      { target: "gemini", kind: "skill", scope: "project", root: join(projectRoot, ".gemini", "skills") },
      { target: "gemini", kind: "skill", scope: "user", root: join(userHome, ".gemini", "skills") },
    );
  }
  return roots;
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function findDefinitionWarnings(
  projectRoot: string,
  userHome: string,
  targets: SkillTarget[],
  destinations: Set<string>,
): Promise<DefinitionWarning[]> {
  const warnings: DefinitionWarning[] = [];
  const seen = new Set<string>();

  for (const location of definitionRoots(projectRoot, userHome, targets)) {
    for (const workflow of WORKFLOWS) {
      const candidates =
        location.kind === "skill"
          ? [join(location.root, workflow, "SKILL.md")]
          : COMMAND_EXTENSIONS.map((extension) =>
              join(location.root, `${workflow}${extension}`),
            );

      for (const candidate of candidates) {
        const key = pathKey(candidate);
        if (destinations.has(key) || seen.has(key) || !(await exists(candidate))) {
          continue;
        }
        seen.add(key);
        const content = await readFile(candidate, "utf8");
        warnings.push({
          workflow,
          kind: location.kind,
          scope: location.scope,
          target: location.target,
          path:
            location.scope === "project"
              ? join(".", candidate.slice(projectRoot.length + 1))
              : candidate,
          packageManaged:
            location.kind === "skill" && generatedFileIsUnmodified(content),
        });
      }
    }
  }

  return warnings;
}

export async function installSkills(
  input: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const root = resolve(input.cwd);
  const userHome = resolve(input.home ?? homedir());
  const result: InstallSkillsResult = {
    installed: [],
    updated: [],
    skipped: [],
    conflicts: [],
    warnings: [],
    aborted: false,
  };
  const plans: PlannedWrite[] = [];

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
        plans.push({ relativePath, destination, desired, action: "install" });
        continue;
      }

      const current = await readFile(destination, "utf8");
      if (normalize(current) === desired) {
        plans.push({ relativePath, destination, desired, action: "skip" });
      } else if (input.force || generatedFileIsUnmodified(current)) {
        plans.push({ relativePath, destination, desired, action: "update" });
      } else {
        plans.push({ relativePath, destination, desired, action: "conflict" });
      }
    }
  }

  const destinations = new Set(plans.map(({ destination }) => pathKey(destination)));
  result.warnings = await findDefinitionWarnings(
    root,
    userHome,
    input.targets,
    destinations,
  );
  result.conflicts = plans
    .filter(({ action }) => action === "conflict")
    .map(({ relativePath }) => relativePath);
  result.skipped = plans
    .filter(({ action }) => action === "skip")
    .map(({ relativePath }) => relativePath);

  if (result.conflicts.length > 0) {
    result.aborted = true;
    return result;
  }

  for (const plan of plans) {
    if (plan.action === "install") {
      await mkdir(dirname(plan.destination), { recursive: true });
      await writeFile(plan.destination, plan.desired, "utf8");
      result.installed.push(plan.relativePath);
    } else if (plan.action === "update") {
      await writeFile(plan.destination, plan.desired, "utf8");
      result.updated.push(plan.relativePath);
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
    "universal-directives.md",
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
