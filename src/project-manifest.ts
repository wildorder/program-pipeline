import { readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * Manifests that mark the directory as belonging to another ecosystem. A
 * package.json dropped next to one of these would misrepresent the project, so
 * setup leaves those repositories alone and runs the CLI through npx instead.
 */
const FOREIGN_MANIFESTS = new Set([
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "build.sbt",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
  "CMakeLists.txt",
]);

const FOREIGN_EXTENSIONS = [".csproj", ".fsproj", ".sln"];

export type ManifestSkipReason = "package.json exists" | "foreign manifest";

export interface CreateProjectManifestResult {
  created: boolean;
  path: string;
  /** The package name written, when a manifest was created. */
  name?: string;
  reason?: ManifestSkipReason;
  /** The file that made this directory look like another ecosystem. */
  foreignManifest?: string;
}

/**
 * Derive a valid npm package name from a directory name. npm allows lowercase
 * letters, digits, and `-._`, and forbids a leading `.` or `_`.
 */
export function toPackageName(directoryName: string): string {
  const slug = directoryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "")
    .replace(/[-.]+$/u, "")
    .slice(0, 214);
  return slug.length > 0 ? slug : "project";
}

async function findForeignManifest(root: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }
  return entries.find(
    (entry) =>
      FOREIGN_MANIFESTS.has(entry) ||
      FOREIGN_EXTENSIONS.some((extension) =>
        entry.toLowerCase().endsWith(extension),
      ),
  );
}

/**
 * Write a minimal placeholder package.json so a brand-new project can pin the
 * pipeline as a devDependency. Deliberately not `npm init --yes`: that writes a
 * stub `test` script that fails by design, which `init` would then pick up as a
 * verify command and every build would fail on it.
 */
export async function createProjectManifest(
  cwd: string,
): Promise<CreateProjectManifestResult> {
  const root = resolve(cwd);
  const path = join(root, "package.json");
  const entries = await readdir(root).catch(() => [] as string[]);
  if (entries.includes("package.json")) {
    return { created: false, path, reason: "package.json exists" };
  }
  const foreignManifest = await findForeignManifest(root);
  if (foreignManifest !== undefined) {
    return { created: false, path, reason: "foreign manifest", foreignManifest };
  }
  const name = toPackageName(basename(root));
  const manifest = {
    name,
    version: "0.0.0",
    private: true,
  };
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
  return { created: true, path, name };
}
