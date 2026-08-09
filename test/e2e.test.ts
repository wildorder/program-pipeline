import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT = 300_000;

interface RunResult {
  code: number;
  output: string;
}

function collect(
  child: ReturnType<typeof spawn>,
  resolvePromise: (result: RunResult) => void,
  rejectPromise: (error: Error) => void,
): void {
  const chunks: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: string) => chunks.push(chunk));
  child.on("error", rejectPromise);
  child.on("close", (code) =>
    resolvePromise({ code: code ?? 1, output: chunks.join("") }),
  );
}

function runShell(commandLine: string, cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    collect(child, resolvePromise, rejectPromise);
  });
}

function runCli(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    collect(child, resolvePromise, rejectPromise);
  });
}

describe("packaged CLI end to end", () => {
  let work: string;
  let project: string;
  let cli: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "program-pipeline-e2e-"));
    project = join(work, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ name: "e2e-project", private: true }, null, 2)}\n`,
      "utf8",
    );

    const pack = await runShell(
      `npm pack --pack-destination "${work}"`,
      REPO_ROOT,
    );
    expect(pack.code, pack.output).toBe(0);
    const tarball = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();

    const install = await runShell(
      `npm install "${join(work, tarball as string)}" --no-audit --no-fund --loglevel=error`,
      project,
    );
    expect(install.code, install.output).toBe(0);
    cli = join(
      project,
      "node_modules",
      "@wildorder",
      "program-pipeline",
      "dist",
      "cli.js",
    );
  }, STEP_TIMEOUT);

  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it(
    "drives init, doctor, install, validate, and build through the packed artifact",
    async () => {
      const init = await runCli(
        [
          cli,
          "init",
          "--cwd",
          project,
          "--name",
          "E2E",
          "--stack",
          "TypeScript/Node",
          "--description",
          "End-to-end fixture project.",
        ],
        project,
      );
      expect(init.code, init.output).toBe(0);
      await expect(
        readFile(join(project, "AGENTS.md"), "utf8"),
      ).resolves.toContain("VERIFY BEFORE CLAIMING COMPLETION");

      const doctor = await runCli([cli, "doctor"], project);
      expect(doctor.code, doctor.output).toBe(0);
      expect(doctor.output).toContain("healthy");

      const install = await runCli(
        [cli, "install", "--cwd", project, "--targets", "claude"],
        project,
      );
      expect(install.code, install.output).toBe(0);
      await expect(
        readFile(
          join(project, ".claude", "skills", "build-program", "SKILL.md"),
          "utf8",
        ),
      ).resolves.toContain("program-pipeline:sha256=");

      await mkdir(join(project, "tasks", "alpha"), { recursive: true });
      await writeFile(
        join(project, "docs", "programs", "alpha-manifest.json"),
        `${JSON.stringify(
          {
            program: { id: "alpha", name: "Alpha", status: "planning" },
            successCriteria: [{ id: "SC-01", description: "Feature works." }],
            workstreams: [
              {
                id: "WS-01",
                name: "Core",
                taskFile: "tasks/alpha/ws-01-core.md",
                status: "not_started",
                dependencies: [],
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(project, "tasks", "alpha", "ws-01-core.md"),
        `# WS-01: Core

## Traceability
- SC-01

## Files Touched
- (NEW) \`src/core.ts\`

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Verification exits successfully.
`,
        "utf8",
      );

      const validate = await runCli(
        [cli, "validate", "alpha", "--cwd", project, "--json"],
        project,
      );
      expect(validate.code, validate.output).toBe(0);
      const report = JSON.parse(validate.output) as { result: string };
      expect(report.result).toBe("PASSED");

      await writeFile(
        join(project, "agent-stub.cjs"),
        `const fs = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  fs.mkdirSync("src", { recursive: true });
  fs.writeFileSync("src/core.ts", "export {};\\n");
  process.exit(prompt.includes("WS-01") ? 0 : 1);
});
`,
        "utf8",
      );
      const configPath = join(project, "pipeline.config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      config.agent = { command: "node", args: ["agent-stub.cjs"] };
      config.verify = { check: 'node -e "process.exit(0)"' };
      // init leaves builds ungated; turn the gate on to exercise it.
      expect(config.requireApprovalBeforeBuild).toBe(false);
      config.requireApprovalBeforeBuild = true;
      await writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      );

      const gated = await runCli(
        [cli, "build", "alpha", "--cwd", project],
        project,
      );
      expect(gated.output).toContain("APPROVAL_REQUIRED");
      expect(gated.code).toBe(2);

      const build = await runCli(
        [cli, "build", "alpha", "--cwd", project, "--yes"],
        project,
      );
      expect(build.code, build.output).toBe(0);
      expect(build.output).toContain("COMPLETE: alpha");

      const manifest = JSON.parse(
        await readFile(
          join(project, "docs", "programs", "alpha-manifest.json"),
          "utf8",
        ),
      ) as { workstreams: Array<{ status: string }> };
      expect(manifest.workstreams[0]?.status).toBe("complete");

      const logs = await readdir(join(project, "build-logs"));
      expect(logs.some((name) => name.endsWith(".jsonl"))).toBe(true);
    },
    STEP_TIMEOUT,
  );
});
