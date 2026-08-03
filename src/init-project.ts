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

async function loadUniversalDirectives(result: InitResult): Promise<string> {
  const source = join(homedir(), ".cursor", "templates", "claude-base.md");
  if (await exists(source)) {
    return readFile(source, "utf8");
  }

  result.warnings.push(
    `Universal directives not found at ${source}; wrote a minimal placeholder.`,
  );
  return "# Agent Directives\n\nRun your organization's setup command to configure universal directives.\n";
}

async function loadTemplate(name: string): Promise<string> {
  return readFile(join(PACKAGE_ROOT, "templates", name), "utf8");
}

export async function initProject(input: InitOptions): Promise<InitResult> {
  const options = initOptionsSchema.parse(input);
  const root = resolve(options.cwd);
  const result: InitResult = { created: [], skipped: [], warnings: [] };
  const universal = await loadUniversalDirectives(result);
  const values = {
    PROJECT_NAME: options.name,
    STACK: options.stack,
    DESCRIPTION: options.description,
    UNIVERSAL_DIRECTIVES: universal.trim(),
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
    ["build-product.ps1", "build-product.ps1"],
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
