import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  loadInstallPrefs,
  saveInstallPrefs,
  type PreferredScope,
} from "./install-prefs.js";
import { findProjectCopies } from "./install-skills.js";
import {
  chooseMany,
  chooseOne,
  confirm,
  defaultStreams,
  isInteractive,
  type PromptStreams,
} from "./prompt.js";
import {
  ALL_TARGETS,
  detectTargets,
  type DetectedTarget,
  type InstallScope,
  type SkillTarget,
} from "./skill-roots.js";

export interface SkillPlanOptions {
  cwd: string;
  /** From `--targets`; presence alone suppresses the wizard. */
  explicitTargets?: SkillTarget[];
  /** From `--scope`. */
  explicitScope?: PreferredScope;
  /** From `--prune` / `--no-prune`. */
  explicitPrune?: boolean;
  /** From `--root <target>=<path>`. */
  roots?: Partial<Record<SkillTarget, string>>;
  /** From `--yes`: take the detected defaults without asking. */
  yes?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  streams?: PromptStreams;
  log?: (line: string) => void;
}

export interface SkillPlan {
  targets: SkillTarget[];
  scopes: InstallScope[];
  pruneProject: boolean;
  /** True when the user backed out; the caller must not write anything. */
  cancelled: boolean;
  detected: DetectedTarget[];
}

/** The option surface `install` and `setup` share, as plain values. */
export interface InstallArgvOptions {
  cwd: string;
  targets?: string;
  scope?: string;
  root: string[];
  force: boolean;
  yes: boolean;
  prune?: boolean;
}

/**
 * Rebuild a run's skill options as an `install` argv, so `setup` can hand off
 * to the CLI it just installed rather than continuing in its own process —
 * where the code in memory predates the files on disk.
 *
 * Every option must survive the round trip. Dropping `--scope` here would
 * silently install to a different root than the user asked for, which is the
 * exact class of failure this handoff exists to prevent.
 */
export function installArgv(
  options: InstallArgvOptions,
  pruneCameFromCli: boolean,
): string[] {
  const argv = ["install", "--cwd", options.cwd];
  if (options.targets !== undefined) argv.push("--targets", options.targets);
  if (options.scope !== undefined) argv.push("--scope", options.scope);
  for (const override of options.root) argv.push("--root", override);
  if (options.force) argv.push("--force");
  if (options.yes) argv.push("--yes");
  // Commander gives --prune a value either way, so only forward a real one.
  if (pruneCameFromCli) argv.push(options.prune ? "--prune" : "--no-prune");
  return argv;
}

export function scopesFor(scope: PreferredScope): InstallScope[] {
  if (scope === "both") return ["user", "project"];
  return [scope];
}

function describeScope(scopes: InstallScope[]): string {
  return scopes.length === 2 ? "user and project" : (scopes[0] ?? "project");
}

/**
 * Decide what to install and where. Interactive only when a human is on both
 * ends of the terminal and has not already answered on the command line;
 * every other path resolves silently from detection and saved preferences.
 */
export async function planSkillInstall(
  options: SkillPlanOptions,
): Promise<SkillPlan> {
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir());
  const streams = options.streams ?? defaultStreams();
  const log = options.log ?? ((line: string) => console.log(line));

  const detected = await detectTargets({
    home,
    env,
    ...(options.roots ? { roots: options.roots } : {}),
  });
  const present = detected.filter((entry) => entry.detected);
  // With nothing detected — a fresh container, an unusual layout — installing
  // everything is the old behavior and beats a silent no-op.
  const fallbackTargets: SkillTarget[] =
    present.length > 0 ? present.map((entry) => entry.target) : [...ALL_TARGETS];

  const prefs = await loadInstallPrefs(home);
  const interactive =
    !options.explicitTargets &&
    !options.yes &&
    isInteractive(streams, env);

  if (!interactive) {
    const targets =
      options.explicitTargets ?? prefs?.targets ?? fallbackTargets;
    const scopes = scopesFor(options.explicitScope ?? prefs?.scope ?? "user");
    if (!options.explicitTargets) {
      const source = prefs ? "saved preferences" : "detected tools";
      log(
        `installing to ${targets.join(", ")} at ${describeScope(scopes)} scope ` +
          `(non-interactive, from ${source}; pass --targets or --scope to override)`,
      );
    }
    return {
      targets,
      scopes,
      pruneProject: options.explicitPrune ?? false,
      cancelled: false,
      detected,
    };
  }

  const chosen = await chooseMany<SkillTarget>({
    title: "Where should the workflow skills go?",
    choices: detected.map((entry) => ({
      value: entry.target,
      label: entry.label,
      hint: entry.detected
        ? entry.userRoot
        : `${entry.userRoot}  (not detected)`,
    })),
    initial: prefs?.targets ?? fallbackTargets,
    streams,
    env,
  });

  if (!chosen) return emptyPlan(detected);
  if (chosen.length === 0) {
    log("no targets selected; nothing to install");
    return emptyPlan(detected);
  }

  let scope = options.explicitScope;
  if (!scope) {
    const picked = await chooseOne<PreferredScope>({
      title: "Install for this machine or just this project?",
      choices: [
        {
          value: "user",
          label: "This machine",
          hint: "one update covers every repository",
        },
        {
          value: "project",
          label: "This project",
          hint: "checked into the repo, pinned per project",
        },
        { value: "both", label: "Both", hint: "project copies shadow machine ones" },
      ],
      initial: prefs?.scope ?? "user",
      streams,
      env,
    });
    if (!picked) return emptyPlan(detected);
    scope = picked;
  }

  const scopes = scopesFor(scope);
  let pruneProject = options.explicitPrune ?? false;

  // Only worth asking when project copies would shadow what we just installed.
  if (
    options.explicitPrune === undefined &&
    scopes.includes("user") &&
    !scopes.includes("project")
  ) {
    const copies = await findProjectCopies(options.cwd, chosen, {
      home,
      env,
      ...(options.roots ? { roots: options.roots } : {}),
    });
    if (copies.managed.length > 0) {
      const answer = await confirm({
        title:
          `Found ${copies.managed.length} project-scope skill file(s) in this repo. ` +
          "They shadow the machine-wide ones. Remove them?",
        initial: true,
        streams,
        env,
      });
      if (answer === undefined) return emptyPlan(detected);
      pruneProject = answer;
    }
    if (copies.modified.length > 0) {
      log(
        `note ${copies.modified.length} edited project-scope skill file(s) will be left in place and keep shadowing:`,
      );
      for (const path of copies.modified) log(`  ${path}`);
    }
  }

  const savedTo = await saveInstallPrefs({ targets: chosen, scope }, home);
  log(`saved install preferences to ${savedTo}`);

  return { targets: chosen, scopes, pruneProject, cancelled: false, detected };
}

function emptyPlan(detected: DetectedTarget[]): SkillPlan {
  return {
    targets: [],
    scopes: [],
    pruneProject: false,
    cancelled: true,
    detected,
  };
}
