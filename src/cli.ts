#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { buildProgram } from "./build-program.js";
import {
  addDevDependencyCommand,
  detectPackageManager,
  PACKAGE_MANAGERS,
  parsePackageManager,
} from "./detect-package-manager.js";
import { initProject } from "./init-project.js";
import {
  DEFAULT_TARGETS,
  doctor,
  installSkills,
  parseTargets,
  type InstallSkillsResult,
  type SkillTarget,
} from "./install-skills.js";
import { packageVersion } from "./package-assets.js";
import { validateWorkstreams } from "./validate.js";

function reportInstall(result: InstallSkillsResult): void {
  for (const path of result.installed) console.log(`installed ${path}`);
  for (const path of result.updated) console.log(`updated ${path}`);
  for (const path of result.skipped) console.log(`unchanged ${path}`);
  for (const warning of result.warnings) {
    const ownership = warning.packageManaged ? "package-managed" : "external";
    console.warn(
      `warning ${warning.scope} ${warning.target} ${warning.kind} (${ownership}) for ${warning.workflow}: ${warning.path}`,
    );
  }
  for (const path of result.conflicts) console.warn(`conflict ${path}`);
  if (result.aborted) {
    console.warn(
      "installation aborted before writing files; resolve conflicts or re-run with --force",
    );
  }
  if (result.conflicts.length > 0) process.exitCode = 1;
}

const program = new Command()
  .name("program-pipeline")
  .description("Provider-neutral program planning and delivery workflows")
  .version(await packageVersion());

program
  .command("init")
  .description(
    "Initialize or adopt a project with the program pipeline structure",
  )
  .option("--name <name>", "Project name (default: package.json name)")
  .option(
    "--stack <stack>",
    "Primary language and technology stack (default: detected from the repository)",
  )
  .option(
    "--description <description>",
    "One-line product description (default: package.json description)",
  )
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--directives <path>",
    "Universal directives override file (defaults to ~/.program-pipeline/universal-directives.md, then the packaged template)",
  )
  .action(
    async (options: {
      name?: string;
      stack?: string;
      description?: string;
      cwd: string;
      directives?: string;
    }) => {
      const result = await initProject({
        cwd: options.cwd,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.stack === undefined ? {} : { stack: options.stack }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        ...(options.directives === undefined
          ? {}
          : { directivesPath: options.directives }),
      });
      for (const path of result.created) console.log(`created ${path}`);
      for (const path of result.updated) console.log(`updated ${path}`);
      for (const path of result.skipped) console.log(`skipped ${path}`);
      for (const warning of result.warnings) console.warn(`warning ${warning}`);
    },
  );

program
  .command("install")
  .description("Install portable workflow skills into a project")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--targets <targets>",
    `Comma-separated targets: ${DEFAULT_TARGETS}`,
    DEFAULT_TARGETS,
  )
  .option("--force", "Overwrite conflicting skill files", false)
  .action(
    async (options: {
      cwd: string;
      targets: string;
      force: boolean;
    }) => {
      const targets: SkillTarget[] = parseTargets(options.targets);
      const result = await installSkills({
        cwd: options.cwd,
        targets,
        force: options.force,
      });
      reportInstall(result);
    },
  );

program
  .command("setup")
  .description(
    "One-step setup: add the package as a devDependency and install workflow skills",
  )
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--targets <targets>",
    `Comma-separated targets: ${DEFAULT_TARGETS}`,
    DEFAULT_TARGETS,
  )
  .option("--force", "Overwrite conflicting skill files", false)
  .option(
    "--pm <manager>",
    `Package manager for the devDependency: ${PACKAGE_MANAGERS.join(", ")} (default: detected from the repository)`,
  )
  .action(
    async (options: {
      cwd: string;
      targets: string;
      force: boolean;
      pm?: string;
    }) => {
      const root = resolve(options.cwd);
      const targets: SkillTarget[] = parseTargets(options.targets);

      if (existsSync(join(root, "package.json"))) {
        const manager =
          options.pm === undefined
            ? detectPackageManager(root)
            : parsePackageManager(options.pm);
        console.log(
          `adding @wildorder/program-pipeline as a devDependency with ${manager}`,
        );
        const exitCode = await new Promise<number>(
          (resolvePromise, rejectPromise) => {
            const child = spawn(
              addDevDependencyCommand(manager, "@wildorder/program-pipeline"),
              { cwd: root, shell: true, stdio: "inherit", windowsHide: true },
            );
            child.on("error", rejectPromise);
            child.on("close", (code) => resolvePromise(code ?? 1));
          },
        );
        if (exitCode !== 0) {
          console.error(
            `${manager} install failed; skills were not installed. Fix the ${manager} error and re-run setup (use --pm to override the detected package manager).`,
          );
          process.exitCode = 1;
          return;
        }
      } else {
        console.warn(
          "warning no package.json found; skipped adding the devDependency (run the CLI via npx, or npm init first)",
        );
      }

      const result = await installSkills({
        cwd: root,
        targets,
        force: options.force,
      });
      reportInstall(result);
      if (!result.aborted) {
        console.log(
          "setup complete; run /init-project from your agent to continue",
        );
      }
    },
  );

program
  .command("doctor")
  .description("Verify packaged templates, schemas, and skills")
  .action(async () => {
    const problems = await doctor();
    if (problems.length === 0) {
      console.log("Program Pipeline package is healthy.");
      return;
    }
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  });

program
  .command("build")
  .description(
    "Execute a program's workstreams with the configured agent and verification gates",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--start-from <workstream-id>", "Resume from a workstream ID or prefix")
  .option("--dry-run", "Print the execution plan without running anything", false)
  .option("--yes", "Approve execution when the config requires approval", false)
  .action(
    async (
      programId: string,
      options: {
        cwd: string;
        startFrom?: string;
        dryRun: boolean;
        yes: boolean;
      },
    ) => {
      const report = await buildProgram({
        cwd: options.cwd,
        programId,
        ...(options.startFrom === undefined
          ? {}
          : { startFrom: options.startFrom }),
        dryRun: options.dryRun,
        approve: options.yes,
        onProgress: (line) => console.log(line),
      });

      if (report.agent) console.log(`agent ${report.agent}`);
      for (const entry of report.plan) {
        const suffix =
          entry.action === "skip" ? ` (skip: ${entry.reason ?? "skipped"})` : "";
        console.log(`plan ${entry.id} ${entry.name}${suffix}`);
      }
      for (const outcome of report.outcomes) {
        console.log(
          `${outcome.status} ${outcome.id} after ${outcome.attempts} attempt(s)`,
        );
      }
      if (report.eventsPath) console.log(`events ${report.eventsPath}`);
      console.log(`${report.result}: ${report.programId}`);
      if (report.reason) console.log(report.reason);
      if (report.result === "FAILED" || report.result === "ABORTED") {
        process.exitCode = 1;
      } else if (report.result === "APPROVAL_REQUIRED") {
        process.exitCode = 2;
      }
    },
  );

program
  .command("validate")
  .description("Run deterministic workstream validation")
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--strict", "Fail on major findings", false)
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (
      programId: string,
      options: { cwd: string; strict: boolean; json: boolean },
    ) => {
      const report = await validateWorkstreams(
        options.cwd,
        programId,
        options.strict,
      );
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const counts = { blocker: 0, major: 0, minor: 0 };
        for (const finding of report.findings) counts[finding.severity] += 1;
        console.log(`${report.result}: ${report.programId}`);
        console.log(
          `blocker=${counts.blocker} major=${counts.major} minor=${counts.minor}`,
        );
        for (const finding of report.findings) {
          const scope = finding.workstreamId
            ? ` ${finding.workstreamId}`
            : "";
          console.log(
            `[${finding.severity}]${scope} ${finding.code}: ${finding.message}`,
          );
        }
      }
      if (report.result === "FAILED") process.exitCode = 1;
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
