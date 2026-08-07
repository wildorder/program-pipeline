import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

export function parsePackageManager(value: string): PackageManager {
  const normalized = value.trim().toLowerCase();
  if ((PACKAGE_MANAGERS as readonly string[]).includes(normalized)) {
    return normalized as PackageManager;
  }
  throw new Error(
    `unknown package manager "${value}"; expected one of: ${PACKAGE_MANAGERS.join(", ")}`,
  );
}

function fromPackageManagerField(
  directory: string,
): PackageManager | undefined {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { packageManager?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest.packageManager !== "string") return undefined;
  // Corepack convention: "<name>@<version>", e.g. "pnpm@9.1.0+sha256.…"
  const name = manifest.packageManager.split("@", 1)[0]?.trim().toLowerCase();
  return (PACKAGE_MANAGERS as readonly string[]).includes(name ?? "")
    ? (name as PackageManager)
    : undefined;
}

function fromLockfile(directory: string): PackageManager | undefined {
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(join(directory, lockfile))) return manager;
  }
  return undefined;
}

/**
 * Detect the project's package manager, walking up from `cwd` because in
 * workspaces the lockfile and `packageManager` field live at the repo root,
 * not necessarily in the package directory. Falls back to npm.
 */
export function detectPackageManager(cwd: string): PackageManager {
  let directory = resolve(cwd);
  for (;;) {
    const manager = fromPackageManagerField(directory) ?? fromLockfile(directory);
    if (manager) return manager;
    const parent = dirname(directory);
    if (parent === directory) return "npm";
    directory = parent;
  }
}

/** pnpm workspaces are always declared by a pnpm-workspace.yaml at the root. */
export function isPnpmWorkspaceRoot(directory: string): boolean {
  return existsSync(join(directory, "pnpm-workspace.yaml"));
}

export function addDevDependencyCommand(
  manager: PackageManager,
  packageName: string,
  options: { pnpmWorkspaceRoot?: boolean } = {},
): string {
  switch (manager) {
    case "npm":
      return `npm install --save-dev ${packageName}`;
    case "pnpm":
      // pnpm refuses to add to a workspace root unless -w makes it explicit.
      return `pnpm add -D${options.pnpmWorkspaceRoot ? " -w" : ""} ${packageName}`;
    case "yarn":
      return `yarn add -D ${packageName}`;
    case "bun":
      return `bun add -d ${packageName}`;
  }
}
