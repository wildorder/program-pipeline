import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT, packageVersion } from "./package-assets.js";

export const initOptionsSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1),
  stack: z.string().min(1),
  description: z.string().min(1),
  home: z.string().min(1).optional(),
  directivesPath: z.string().min(1).optional(),
});

export type InitOptions = z.infer<typeof initOptionsSchema>;

export interface InitResult {
  created: string[];
  skipped: string[];
  warnings: string[];
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

async function detectVerifyCommands(
  root: string,
): Promise<Record<string, string>> {
  let scripts: Record<string, string>;
  try {
    const raw = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    scripts = raw.scripts ?? {};
  } catch {
    return {};
  }

  const verify: Record<string, string> = {};
  if (scripts.build) verify.build = "npm run build";
  if (scripts.typecheck) verify.typecheck = "npm run typecheck";
  if (scripts.lint) verify.lint = "npm run lint";
  if (scripts.test) verify.test = "npm test";
  return verify;
}

export async function initProject(input: InitOptions): Promise<InitResult> {
  const options = initOptionsSchema.parse(input);
  const root = resolve(options.cwd);
  const home = resolve(options.home ?? homedir());
  const result: InitResult = { created: [], skipped: [], warnings: [] };
  const universal = await loadUniversalDirectives(home, options.directivesPath);
  const values = {
    PROJECT_NAME: options.name,
    STACK: options.stack,
    DESCRIPTION: options.description,
    UNIVERSAL_DIRECTIVES: universal.content.trim(),
    UNIVERSAL_SOURCE: universal.source,
  };

  await mkdir(root, { recursive: true });
  await Promise.all([
    mkdir(join(root, "docs", "programs"), { recursive: true }),
    mkdir(join(root, "docs", "snapshots"), { recursive: true }),
    mkdir(join(root, "tasks"), { recursive: true }),
    mkdir(join(root, "build-logs"), { recursive: true }),
  ]);

  for (const [relativePath, templateName] of [
    ["docs/vision.md", "vision.md"],
    ["AGENTS.md", "AGENTS.md"],
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
      requireApprovalBeforeBuild: true,
      verify: await detectVerifyCommands(root),
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
