import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SkillTarget = "cursor" | "claude" | "openclaw" | "codex" | "gemini";
export type InstallScope = "user" | "project";

/** Where a definition was found, for warnings that never become writes. */
export interface ScanRoot {
  kind: "command" | "skill";
  scope: InstallScope;
  root: string;
}

interface ScanContext {
  home: string;
  projectRoot: string;
  /** The target's resolved config home, e.g. ~/.codex. */
  configHome: string;
}

interface TargetSpec {
  target: SkillTarget;
  label: string;
  /**
   * Directory whose presence means the tool is installed for this user.
   * Resolved under the user's home unless {@link TargetSpec.homeEnv} moves it.
   */
  configDir: string;
  /**
   * The tool's own environment variable for relocating its config home.
   * Only set where the variable is documented — a wrong guess here silently
   * installs into a directory the tool never reads, and the
   * `PROGRAM_PIPELINE_SKILLS_ROOT_*` override covers the rest.
   */
  homeEnv?: string;
  /**
   * User-scope skills root. Receives the resolved config home *and* the raw
   * home, because a target may write outside its own config dir.
   */
  userSkills: (configHome: string, home: string) => string;
  /** Project-scope skills root, relative to the project root. */
  projectSkills: string;
  /** Roots scanned for shadowing definitions but never written to. */
  extraScan?: (context: ScanContext) => ScanRoot[];
}

const SPECS: TargetSpec[] = [
  {
    target: "claude",
    label: "Claude Code",
    configDir: ".claude",
    homeEnv: "CLAUDE_CONFIG_DIR",
    userSkills: (configHome) => join(configHome, "skills"),
    projectSkills: join(".claude", "skills"),
    extraScan: ({ home, projectRoot }) => [
      { kind: "command", scope: "project", root: join(projectRoot, ".claude", "commands") },
      { kind: "command", scope: "user", root: join(home, ".claude", "commands") },
    ],
  },
  {
    target: "cursor",
    label: "Cursor",
    configDir: ".cursor",
    userSkills: (configHome) => join(configHome, "skills"),
    projectSkills: join(".cursor", "skills"),
    // Cursor also reads the cross-tool .agents tree and Claude's skills dir,
    // so a definition in either shadows what we install.
    extraScan: ({ home, projectRoot }) => [
      { kind: "command", scope: "project", root: join(projectRoot, ".cursor", "commands") },
      { kind: "command", scope: "user", root: join(home, ".cursor", "commands") },
      { kind: "skill", scope: "project", root: join(projectRoot, ".agents", "skills") },
      { kind: "skill", scope: "project", root: join(projectRoot, ".claude", "skills") },
      { kind: "skill", scope: "user", root: join(home, ".agents", "skills") },
      { kind: "skill", scope: "user", root: join(home, ".claude", "skills") },
    ],
  },
  {
    target: "codex",
    label: "Codex",
    configDir: ".codex",
    homeEnv: "CODEX_HOME",
    // Codex discovers skills in the cross-tool .agents directory, which does
    // not move with CODEX_HOME — so detection and the write root diverge here
    // on purpose.
    userSkills: (_configHome, home) => join(home, ".agents", "skills"),
    projectSkills: join(".agents", "skills"),
    extraScan: ({ configHome }) => [
      { kind: "skill", scope: "user", root: join(configHome, "skills") },
    ],
  },
  {
    target: "gemini",
    label: "Gemini CLI",
    configDir: ".gemini",
    userSkills: (configHome) => join(configHome, "skills"),
    projectSkills: join(".gemini", "skills"),
  },
  {
    target: "openclaw",
    label: "OpenClaw",
    configDir: ".openclaw",
    userSkills: (configHome) => join(configHome, "skills"),
    projectSkills: "skills",
    extraScan: ({ configHome }) => [
      { kind: "skill", scope: "user", root: join(configHome, "workspace", "skills") },
    ],
  },
];

export const ALL_TARGETS = SPECS.map((spec) => spec.target);
export const DEFAULT_TARGETS = ALL_TARGETS.join(",");

/** How a target's skills root was chosen, for `doctor` output. */
export type RootSource = "flag" | "env" | "default";

export interface DetectedTarget {
  target: SkillTarget;
  label: string;
  /** Resolved absolute user-scope skills root. */
  userRoot: string;
  /** Project-scope skills root, relative to the project root. */
  projectRoot: string;
  /** Directory whose presence implies the tool is installed. */
  configHome: string;
  detected: boolean;
  source: RootSource;
}

export interface ResolveContext {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-target `--root` overrides; highest precedence. */
  roots?: Partial<Record<SkillTarget, string>>;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The escape hatch for a layout this package does not know about. */
export function overrideEnvName(target: SkillTarget): string {
  return `PROGRAM_PIPELINE_SKILLS_ROOT_${target.toUpperCase()}`;
}

export function parseTargets(value: string): SkillTarget[] {
  const values = value
    .split(",")
    .map((target) => target.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter(
    (target) => !ALL_TARGETS.includes(target as SkillTarget),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown target(s): ${invalid.join(", ")}. Expected: ${ALL_TARGETS.join(", ")}.`,
    );
  }
  return [...new Set(values)] as SkillTarget[];
}

/** `--root claude=/path` entries into a per-target override map. */
export function parseRootOverrides(
  entries: string[],
): Partial<Record<SkillTarget, string>> {
  const overrides: Partial<Record<SkillTarget, string>> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error(
        `Invalid --root "${entry}"; expected <target>=<path>, e.g. claude=/opt/claude/skills.`,
      );
    }
    const [target] = parseTargets(entry.slice(0, separator));
    const path = entry.slice(separator + 1).trim();
    if (!target || !path) {
      throw new Error(
        `Invalid --root "${entry}"; expected <target>=<path>, e.g. claude=/opt/claude/skills.`,
      );
    }
    overrides[target] = resolve(path);
  }
  return overrides;
}

function configHomeFor(
  spec: TargetSpec,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const override = spec.homeEnv ? env[spec.homeEnv]?.trim() : undefined;
  return override ? resolve(override) : join(home, spec.configDir);
}

/**
 * Resolve every target's roots and report which tools are actually present.
 * Detection is what keeps an install from creating config directories for
 * tools the developer does not use.
 */
export async function detectTargets(
  context: ResolveContext = {},
): Promise<DetectedTarget[]> {
  const env = context.env ?? process.env;
  const home = resolve(context.home ?? homedir());

  return Promise.all(
    SPECS.map(async (spec): Promise<DetectedTarget> => {
      const configHome = configHomeFor(spec, home, env);
      const flag = context.roots?.[spec.target];
      const envOverride = env[overrideEnvName(spec.target)]?.trim();

      let userRoot: string;
      let source: RootSource;
      if (flag) {
        userRoot = resolve(flag);
        source = "flag";
      } else if (envOverride) {
        userRoot = resolve(envOverride);
        source = "env";
      } else {
        userRoot = spec.userSkills(configHome, home);
        // The tool's own home variable only counts as the source when it
        // actually moved the skills root; for Codex it moves detection only.
        const fromDefaultHome = spec.userSkills(
          join(home, spec.configDir),
          home,
        );
        source = userRoot === fromDefaultHome ? "default" : "env";
      }

      return {
        target: spec.target,
        label: spec.label,
        userRoot,
        projectRoot: spec.projectSkills,
        configHome,
        detected: await pathExists(configHome),
        source,
      };
    }),
  );
}

/**
 * Every root worth scanning for a competing definition of a workflow: each
 * target's own skills roots at both scopes, plus the command directories and
 * cross-tool trees that shadow them.
 */
export function scanRoots(
  detected: DetectedTarget[],
  projectRoot: string,
  home: string,
): Array<ScanRoot & { target: SkillTarget }> {
  const roots: Array<ScanRoot & { target: SkillTarget }> = [];
  const byTarget = new Map(detected.map((entry) => [entry.target, entry]));

  for (const spec of SPECS) {
    const entry = byTarget.get(spec.target);
    if (!entry) continue;
    roots.push(
      {
        target: spec.target,
        kind: "skill",
        scope: "project",
        root: join(projectRoot, entry.projectRoot),
      },
      { target: spec.target, kind: "skill", scope: "user", root: entry.userRoot },
    );
    for (const extra of spec.extraScan?.({
      home,
      projectRoot,
      configHome: entry.configHome,
    }) ?? []) {
      roots.push({ target: spec.target, ...extra });
    }
  }

  return roots;
}
