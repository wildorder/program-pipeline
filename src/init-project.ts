import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT, packageVersion } from "./package-assets.js";

export const initOptionsSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1).optional(),
  stack: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  home: z.string().min(1).optional(),
  directivesPath: z.string().min(1).optional(),
});

export type InitOptions = z.infer<typeof initOptionsSchema>;

export interface InitResult {
  created: string[];
  updated: string[];
  skipped: string[];
  warnings: string[];
}

const UNIVERSAL_PATTERN = /<!-- BEGIN UNIVERSAL[\s\S]*?<!-- END UNIVERSAL -->/u;

interface PackageMetadata {
  name?: string;
  description?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function interpolate(
  template: string,
  values: Record<string, string>,
): string {
  return Object.entries(values).reduce(
    (output, [key, value]) => output.replaceAll(`{{${key}}}`, value),
    template,
  );
}

async function writeIfMissing(
  root: string,
  relativePath: string,
  content: string,
  result: InitResult,
): Promise<void> {
  const destination = join(root, relativePath);
  if (await exists(destination)) {
    result.skipped.push(relativePath);
    return;
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  result.created.push(relativePath);
}

interface UniversalDirectives {
  content: string;
  source: string;
}

async function loadUniversalDirectives(
  home: string,
  explicitPath: string | undefined,
): Promise<UniversalDirectives> {
  if (explicitPath) {
    const path = resolve(explicitPath);
    if (!(await exists(path))) {
      throw new Error(`Universal directives override not found: ${path}`);
    }
    return { content: await readFile(path, "utf8"), source: path };
  }

  const override = join(home, ".program-pipeline", "universal-directives.md");
  if (await exists(override)) {
    return { content: await readFile(override, "utf8"), source: override };
  }

  return {
    content: await loadTemplate("universal-directives.md"),
    source: "@wildorder/program-pipeline packaged default",
  };
}

async function loadTemplate(name: string): Promise<string> {
  return readFile(join(PACKAGE_ROOT, "templates", name), "utf8");
}

async function readPackageMetadata(
  root: string,
): Promise<PackageMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as PackageMetadata;
  } catch {
    return undefined;
  }
}

function detectVerifyCommands(
  pkg: PackageMetadata | undefined,
): Record<string, string> {
  const scripts = pkg?.scripts ?? {};
  const verify: Record<string, string> = {};
  if (scripts.build) verify.build = "npm run build";
  if (scripts.typecheck) verify.typecheck = "npm run typecheck";
  if (scripts.lint) verify.lint = "npm run lint";
  if (scripts.test) verify.test = "npm test";
  return verify;
}

const KNOWN_FRAMEWORKS: Record<string, string> = {
  react: "React",
  next: "Next.js",
  vue: "Vue",
  svelte: "Svelte",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  commander: "Commander CLI",
};

const KNOWN_TEST_RUNNERS = ["vitest", "jest", "mocha", "playwright"];

async function detectStack(
  root: string,
  pkg: PackageMetadata | undefined,
): Promise<string | undefined> {
  const parts: string[] = [];

  if (pkg) {
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const usesTypeScript =
      Boolean(dependencies.typescript) ||
      (await exists(join(root, "tsconfig.json")));
    const node = pkg.engines?.node ? `Node ${pkg.engines.node}` : "Node.js";
    parts.push(usesTypeScript ? `TypeScript on ${node}` : `JavaScript on ${node}`);

    const frameworks = Object.entries(KNOWN_FRAMEWORKS)
      .filter(([dependency]) => dependencies[dependency])
      .map(([, label]) => label);
    if (frameworks.length > 0) parts.push(`frameworks: ${frameworks.join(", ")}`);

    const testRunners = KNOWN_TEST_RUNNERS.filter(
      (runner) => dependencies[runner],
    );
    if (testRunners.length > 0) parts.push(`tests: ${testRunners.join(", ")}`);
  }

  if (
    (await exists(join(root, "pyproject.toml"))) ||
    (await exists(join(root, "requirements.txt")))
  ) {
    parts.push("Python");
  }
  if (await exists(join(root, "go.mod"))) parts.push("Go");
  if (await exists(join(root, "Cargo.toml"))) parts.push("Rust");

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function dependencyRows(pkg: PackageMetadata | undefined): string {
  const entries = Object.entries(pkg?.dependencies ?? {}).slice(0, 15);
  if (entries.length === 0) return "| [Package] | [Version] |";
  return entries
    .map(([name, version]) => `| ${name} | ${version} |`)
    .join("\n");
}

const PIPELINE_OWNED_DOCS = new Set(["AGENTS.md", "CLAUDE.md"]);
const CONTEXT_DOC_LIMIT = 25;

async function detectContextDocs(root: string): Promise<string[]> {
  const docs: string[] = [];

  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !PIPELINE_OWNED_DOCS.has(entry.name)
      ) {
        docs.push(entry.name);
      }
    }
  } catch {
    return [];
  }

  try {
    for (const entry of await readdir(join(root, "docs"), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const relativePath = relative(
        root,
        join(entry.parentPath, entry.name),
      ).replaceAll("\\", "/");
      if (
        relativePath === "docs/vision.md" ||
        relativePath === "docs/as-built.md" ||
        relativePath.startsWith("docs/programs/") ||
        relativePath.startsWith("docs/snapshots/")
      ) {
        continue;
      }
      docs.push(relativePath);
    }
  } catch {
    // No docs directory yet.
  }

  return [...new Set(docs)].sort().slice(0, CONTEXT_DOC_LIMIT);
}

async function upsertUniversalBlock(
  root: string,
  block: string,
  values: Record<string, string>,
  result: InitResult,
): Promise<void> {
  const destination = join(root, "AGENTS.md");
  if (!(await exists(destination))) {
    const template = await loadTemplate("AGENTS.md");
    await writeFile(destination, interpolate(template, values), "utf8");
    result.created.push("AGENTS.md");
    return;
  }

  const current = await readFile(destination, "utf8");
  if (UNIVERSAL_PATTERN.test(current)) {
    const next = current.replace(UNIVERSAL_PATTERN, block);
    if (next === current) {
      result.skipped.push("AGENTS.md");
    } else {
      await writeFile(destination, next, "utf8");
      result.updated.push("AGENTS.md (universal block updated)");
    }
    return;
  }

  await writeFile(destination, `${block}\n\n---\n\n${current}`, "utf8");
  result.updated.push("AGENTS.md (universal block added)");
}

export async function initProject(input: InitOptions): Promise<InitResult> {
  const options = initOptionsSchema.parse(input);
  const root = resolve(options.cwd);
  const home = resolve(options.home ?? homedir());
  const result: InitResult = { created: [], updated: [], skipped: [], warnings: [] };

  const pkg = await readPackageMetadata(root);
  const name = options.name ?? pkg?.name;
  if (!name) {
    throw new Error(
      "Project name not provided and no package.json name found; pass --name.",
    );
  }
  const description = options.description ?? pkg?.description;
  if (!description) {
    throw new Error(
      "Project description not provided and no package.json description found; pass --description.",
    );
  }
  let stack = options.stack ?? (await detectStack(root, pkg));
  if (!stack) {
    stack = "[Document the stack]";
    result.warnings.push(
      "Stack not provided and none detected; edit the Tech Stack sections or re-run with --stack.",
    );
  }

  const contextDocs = await detectContextDocs(root);
  const universal = await loadUniversalDirectives(home, options.directivesPath);
  const values = {
    PROJECT_NAME: name,
    STACK: stack,
    DESCRIPTION: description,
    UNIVERSAL_DIRECTIVES: universal.content.trim(),
    UNIVERSAL_SOURCE: universal.source,
    DEPENDENCY_ROWS: dependencyRows(pkg),
  };
  const universalBlock = `<!-- BEGIN UNIVERSAL — source: ${universal.source} -->\n${universal.content.trim()}\n<!-- END UNIVERSAL -->`;

  await mkdir(root, { recursive: true });
  await Promise.all([
    mkdir(join(root, "docs", "programs"), { recursive: true }),
    mkdir(join(root, "docs", "snapshots"), { recursive: true }),
    mkdir(join(root, "tasks"), { recursive: true }),
    mkdir(join(root, "build-logs"), { recursive: true }),
  ]);

  await upsertUniversalBlock(root, universalBlock, values, result);

  for (const [relativePath, templateName] of [
    ["docs/vision.md", "vision.md"],
    ["CLAUDE.md", "CLAUDE.md"],
  ] as const) {
    const template = await loadTemplate(templateName);
    await writeIfMissing(
      root,
      relativePath,
      interpolate(template, values),
      result,
    );
  }

  const config = `${JSON.stringify(
    {
      schemaVersion: 1,
      pipelineVersion: await packageVersion(),
      visionPath: "docs/vision.md",
      requireApprovalBeforeBuild: false,
      verify: detectVerifyCommands(pkg),
      contextDocs,
      build: { commit: true },
    },
    null,
    2,
  )}\n`;
  await writeIfMissing(root, "pipeline.config.json", config, result);

  const gitignore = join(root, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(gitignore, "build-logs/\n", "utf8");
    result.created.push(".gitignore");
  } else {
    const content = await readFile(gitignore, "utf8");
    if (!content.split(/\r?\n/u).includes("build-logs/")) {
      await appendFile(
        gitignore,
        `${content.endsWith("\n") ? "" : "\n"}build-logs/\n`,
        "utf8",
      );
      result.created.push(".gitignore (updated)");
    } else {
      result.skipped.push(".gitignore");
    }
  }

  return result;
}
