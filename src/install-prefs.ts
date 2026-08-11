import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ALL_TARGETS, type InstallScope, type SkillTarget } from "./skill-roots.js";

/**
 * Which agent tools a developer uses is a property of the developer, not of
 * any one repository — so the wizard's answer is remembered per machine.
 * Without this, the `prepare` hook and every later non-interactive run would
 * silently re-derive defaults and undo the choice.
 */
export const PREFS_PATH = join(".program-pipeline", "install.json");

export type PreferredScope = InstallScope | "both";

const prefsSchema = z.object({
  schemaVersion: z.literal(1),
  targets: z.array(z.string()).default([]),
  scope: z.enum(["user", "project", "both"]).default("user"),
});

export interface InstallPrefs {
  targets: SkillTarget[];
  scope: PreferredScope;
}

function prefsFile(home: string | undefined): string {
  return join(resolve(home ?? homedir()), PREFS_PATH);
}

/** Returns undefined when no usable preference has been recorded yet. */
export async function loadInstallPrefs(
  home?: string,
): Promise<InstallPrefs | undefined> {
  let raw: string;
  try {
    raw = await readFile(prefsFile(home), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-corrupted preference file must not break installs; the caller
    // falls back to detection.
    return undefined;
  }

  const result = prefsSchema.safeParse(parsed);
  if (!result.success) return undefined;

  // Unknown targets are dropped rather than rejected, so a file written by a
  // newer version stays usable after a downgrade.
  const targets = result.data.targets.filter((target): target is SkillTarget =>
    ALL_TARGETS.includes(target as SkillTarget),
  );
  if (targets.length === 0) return undefined;
  return { targets, scope: result.data.scope };
}

export async function saveInstallPrefs(
  prefs: InstallPrefs,
  home?: string,
): Promise<string> {
  const path = prefsFile(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, ...prefs }, null, 2)}\n`,
    "utf8",
  );
  return path;
}
