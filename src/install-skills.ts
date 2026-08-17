import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PACKAGE_ROOT } from "./package-assets.js";
import {
  detectTargets,
  pathExists,
  scanRoots,
  type DetectedTarget,
  type InstallScope,
  type SkillTarget,
} from "./skill-roots.js";

export {
  ALL_TARGETS,
  DEFAULT_TARGETS,
  detectTargets,
  overrideEnvName,
  parseRootOverrides,
  parseTargets,
  type DetectedTarget,
  type InstallScope,
  type RootSource,
  type SkillTarget,
} from "./skill-roots.js";

/**
 * The skills that still ship. Both are human-judgment steps that sit outside
 * the automated loop: deciding what to build, and deciding how the project is
 * set up. Everything else became a CLI command that composes its own brief.
 */
export const WORKFLOWS = ["init-project", "plan-program"] as const;

/**
 * Skills this package used to install and now removes.
 *
 * Their work moved into `author`, `converge`, `review`, `build`, and
 * `as-built`, which compose their own briefs and spawn clean agents. A stale
 * copy left in a skills directory keeps instructing an agent to do that work
 * inside its own session instead — which is precisely the behavior those
 * commands exist to replace — so leaving them installed would quietly undo
 * the change. Unmodified copies are deleted; edited ones are reported and
 * left for a human.
 */
export const RETIRED_WORKFLOWS = [
  "author-workstreams",
  "validate-workstreams",
  "review-program",
  "build-program",
  "update-as-built",
] as const;

export type Workflow = (typeof WORKFLOWS)[number];
export type RetiredWorkflow = (typeof RETIRED_WORKFLOWS)[number];
export type KnownWorkflow = Workflow | RetiredWorkflow;

/** Every name this package has ever installed, for scanning and cleanup. */
const ALL_KNOWN_WORKFLOWS: readonly KnownWorkflow[] = [
  ...WORKFLOWS,
  ...RETIRED_WORKFLOWS,
];

export interface InstallSkillsOptions {
  cwd: string;
  targets: SkillTarget[];
  force?: boolean;
  home?: string;
  /**
   * Where the skills land. Defaults to project scope so existing programmatic
   * callers keep their behavior; the CLI chooses user scope explicitly.
   */
  scopes?: InstallScope[];
  /**
   * Remove project-scope copies that this package generated and the user has
   * not edited. Project skills shadow user skills in most harnesses, so a
   * user-scope install is silently ineffective until the stale copies go.
   */
  pruneProject?: boolean;
  /** Per-target root overrides, from `--root <target>=<path>`. */
  roots?: Partial<Record<SkillTarget, string>>;
  env?: NodeJS.ProcessEnv;
}

export interface DefinitionWarning {
  workflow: KnownWorkflow;
  kind: "command" | "skill";
  scope: InstallScope;
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
  /** Project-scope copies removed because their marker proved them unmodified. */
  pruned: string[];
  /** Project-scope copies left alone because the user had edited them. */
  pruneSkipped: string[];
  /** Retired skills removed because their marker proved them unmodified. */
  retired: string[];
  /** Retired skills left in place because the user had edited them. */
  retiredKept: string[];
  aborted: boolean;
}

const MARKER_PATTERN = /<!-- program-pipeline:sha256=([a-f0-9]{64}) -->\n?/u;
const COMMAND_EXTENSIONS = [".md", ".mdc", ".markdown", ".txt"] as const;

interface PlannedWrite {
  label: string;
  destination: string;
  desired: string;
  action: "install" | "update" | "skip" | "conflict";
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

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function findDefinitionWarnings(
  projectRoot: string,
  userHome: string,
  detected: DetectedTarget[],
  targets: SkillTarget[],
  destinations: Set<string>,
): Promise<DefinitionWarning[]> {
  const warnings: DefinitionWarning[] = [];
  const seen = new Set<string>();
  const selected = detected.filter((entry) => targets.includes(entry.target));

  for (const location of scanRoots(selected, projectRoot, userHome)) {
    for (const workflow of ALL_KNOWN_WORKFLOWS) {
      const candidates =
        location.kind === "skill"
          ? [join(location.root, workflow, "SKILL.md")]
          : COMMAND_EXTENSIONS.map((extension) =>
              join(location.root, `${workflow}${extension}`),
            );

      for (const candidate of candidates) {
        const key = pathKey(candidate);
        if (
          destinations.has(key) ||
          seen.has(key) ||
          !(await pathExists(candidate))
        ) {
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

/** Best-effort cleanup so pruning does not leave empty scaffolding behind. */
async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // Still has content, or never existed. Either way there is nothing to do.
  }
}

export interface ProjectCopies {
  /** Generated by this package and unmodified — safe to remove. */
  managed: string[];
  /** Edited since generation, or never ours — only a human should touch these. */
  modified: string[];
}

/**
 * Project-scope skill files for the given targets. Project skills shadow
 * user-scope ones, so the caller needs this before a user-scope install to
 * know whether the install would actually take effect.
 */
export async function findProjectCopies(
  cwd: string,
  targets: SkillTarget[],
  options: { home?: string; env?: NodeJS.ProcessEnv; roots?: Partial<Record<SkillTarget, string>> } = {},
): Promise<ProjectCopies> {
  const root = resolve(cwd);
  const detected = await detectTargets({
    home: resolve(options.home ?? homedir()),
    ...(options.env ? { env: options.env } : {}),
    ...(options.roots ? { roots: options.roots } : {}),
  });
  const copies: ProjectCopies = { managed: [], modified: [] };

  for (const entry of detected) {
    if (!targets.includes(entry.target)) continue;
    for (const workflow of ALL_KNOWN_WORKFLOWS) {
      const label = join(entry.projectRoot, workflow, "SKILL.md");
      const path = join(root, label);
      if (!(await pathExists(path))) continue;
      if (generatedFileIsUnmodified(await readFile(path, "utf8"))) {
        copies.managed.push(label);
      } else {
        copies.modified.push(label);
      }
    }
  }

  return copies;
}

async function pruneProjectCopies(
  projectRoot: string,
  detected: DetectedTarget[],
  targets: SkillTarget[],
  result: InstallSkillsResult,
): Promise<void> {
  for (const entry of detected) {
    if (!targets.includes(entry.target)) continue;
    const skillsRoot = join(projectRoot, entry.projectRoot);
    for (const workflow of ALL_KNOWN_WORKFLOWS) {
      const path = join(skillsRoot, workflow, "SKILL.md");
      if (!(await pathExists(path))) continue;
      const label = join(entry.projectRoot, workflow, "SKILL.md");
      if (generatedFileIsUnmodified(await readFile(path, "utf8"))) {
        await rm(path);
        await removeIfEmpty(dirname(path));
        result.pruned.push(label);
      } else {
        result.pruneSkipped.push(label);
      }
    }
    await removeIfEmpty(skillsRoot);
  }
}

/**
 * Remove retired skills from **both** scopes, whatever scope this run is
 * installing into.
 *
 * Scoping this to the install's own scopes was wrong: a stale skill almost
 * always sits in the scope you *stopped* using. A project installed before
 * the move to user-scope defaults keeps its project copies, and a later
 * user-scope install would never look at them — leaving the retired skills
 * exactly where the agent still reads them.
 *
 * Called only after a successful install, for the same reason pruning is: a
 * run that aborted on a conflict must not have deleted anything.
 */
async function retireWorkflows(
  projectRoot: string,
  detected: DetectedTarget[],
  targets: SkillTarget[],
  result: InstallSkillsResult,
): Promise<void> {
  const scopes: InstallScope[] = ["user", "project"];
  const seen = new Set<string>();
  for (const entry of detected) {
    if (!targets.includes(entry.target)) continue;
    for (const scope of scopes) {
      const skillsRoot =
        scope === "user"
          ? entry.userRoot
          : join(projectRoot, entry.projectRoot);
      for (const workflow of RETIRED_WORKFLOWS) {
        const path = join(skillsRoot, workflow, "SKILL.md");
        const key = pathKey(path);
        // Root overrides can point two targets at one directory.
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(await pathExists(path))) continue;

        const label =
          scope === "user"
            ? path
            : join(entry.projectRoot, workflow, "SKILL.md");
        if (generatedFileIsUnmodified(await readFile(path, "utf8"))) {
          await rm(path);
          await removeIfEmpty(dirname(path));
          result.retired.push(label);
        } else {
          result.retiredKept.push(label);
        }
      }
    }
  }
}

export async function installSkills(
  input: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const root = resolve(input.cwd);
  const userHome = resolve(input.home ?? homedir());
  const scopes = input.scopes ?? ["project"];
  const result: InstallSkillsResult = {
    installed: [],
    updated: [],
    skipped: [],
    conflicts: [],
    warnings: [],
    pruned: [],
    pruneSkipped: [],
    retired: [],
    retiredKept: [],
    aborted: false,
  };

  const detected = await detectTargets({
    home: userHome,
    ...(input.env ? { env: input.env } : {}),
    ...(input.roots ? { roots: input.roots } : {}),
  });
  const byTarget = new Map(detected.map((entry) => [entry.target, entry]));
  const plans: PlannedWrite[] = [];
  const planned = new Set<string>();

  for (const scope of scopes) {
    for (const target of input.targets) {
      const entry = byTarget.get(target);
      if (!entry) continue;
      const skillsRoot =
        scope === "user" ? entry.userRoot : join(root, entry.projectRoot);

      for (const workflow of WORKFLOWS) {
        const destination = join(skillsRoot, workflow, "SKILL.md");
        const key = pathKey(destination);
        // Overrides can point two targets at one directory; write it once.
        if (planned.has(key)) continue;
        planned.add(key);

        const label =
          scope === "user"
            ? destination
            : join(entry.projectRoot, workflow, "SKILL.md");
        const source = await readFile(
          join(PACKAGE_ROOT, "skills", workflow, "SKILL.md"),
          "utf8",
        );
        const desired = withMarker(source);

        if (!(await pathExists(destination))) {
          plans.push({ label, destination, desired, action: "install" });
          continue;
        }

        const current = await readFile(destination, "utf8");
        if (normalize(current) === desired) {
          plans.push({ label, destination, desired, action: "skip" });
        } else if (input.force || generatedFileIsUnmodified(current)) {
          plans.push({ label, destination, desired, action: "update" });
        } else {
          plans.push({ label, destination, desired, action: "conflict" });
        }
      }
    }
  }

  result.warnings = await findDefinitionWarnings(
    root,
    userHome,
    detected,
    input.targets,
    planned,
  );
  result.conflicts = plans
    .filter(({ action }) => action === "conflict")
    .map(({ label }) => label);
  result.skipped = plans
    .filter(({ action }) => action === "skip")
    .map(({ label }) => label);

  if (result.conflicts.length > 0) {
    result.aborted = true;
    return result;
  }

  for (const plan of plans) {
    if (plan.action === "install") {
      await mkdir(dirname(plan.destination), { recursive: true });
      await writeFile(plan.destination, plan.desired, "utf8");
      result.installed.push(plan.label);
    } else if (plan.action === "update") {
      await writeFile(plan.destination, plan.desired, "utf8");
      result.updated.push(plan.label);
    }
  }

  // Retired skills go from both scopes regardless of where this run installs:
  // a stale copy anywhere keeps telling an agent to do work that is now a
  // command.
  await retireWorkflows(root, detected, input.targets, result);

  // Only after a clean user-scope install: pruning first would delete the
  // developer's working skills if the install then aborted.
  if (input.pruneProject && scopes.includes("user") && !scopes.includes("project")) {
    await pruneProjectCopies(root, detected, input.targets, result);
  }

  return result;
}

export async function doctor(): Promise<string[]> {
  const problems: string[] = [];
  for (const workflow of WORKFLOWS) {
    const path = join(PACKAGE_ROOT, "skills", workflow, "SKILL.md");
    if (!(await pathExists(path))) {
      problems.push(`Missing packaged skill: ${workflow}`);
    }
  }
  for (const template of [
    "vision.md",
    "AGENTS.md",
    "CLAUDE.md",
    "universal-directives.md",
  ]) {
    if (!(await pathExists(join(PACKAGE_ROOT, "templates", template)))) {
      problems.push(`Missing packaged template: ${template}`);
    }
  }
  for (const schema of [
    "manifest.schema.json",
    "pipeline-config.schema.json",
  ]) {
    if (!(await pathExists(join(PACKAGE_ROOT, "schemas", schema)))) {
      problems.push(`Missing packaged schema: ${schema}`);
    }
  }
  return problems;
}
