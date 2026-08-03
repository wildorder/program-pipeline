#!/usr/bin/env node

import { Command } from "commander";
import { initProject } from "./init-project.js";
import {
  doctor,
  installSkills,
  parseTargets,
  type SkillTarget,
} from "./install-skills.js";
import { packageVersion } from "./package-assets.js";
import { validateWorkstreams } from "./validate.js";

const program = new Command()
  .name("program-pipeline")
  .description("Provider-neutral program planning and delivery workflows")
  .version(await packageVersion());

program
  .command("init")
  .description("Initialize a project with the program pipeline structure")
  .requiredOption("--name <name>", "Project name")
  .requiredOption("--stack <stack>", "Primary language and technology stack")
  .requiredOption("--description <description>", "One-line product description")
  .option("--cwd <path>", "Project directory", process.cwd())
  .action(
    async (options: {
      name: string;
      stack: string;
      description: string;
      cwd: string;
    }) => {
      const result = await initProject(options);
      for (const path of result.created) console.log(`created ${path}`);
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
    "Comma-separated targets: cursor,claude,openclaw",
    "cursor,claude,openclaw",
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
      for (const path of result.installed) console.log(`installed ${path}`);
      for (const path of result.updated) console.log(`updated ${path}`);
      for (const path of result.skipped) console.log(`unchanged ${path}`);
      for (const path of result.conflicts) console.warn(`conflict ${path}`);
      if (result.conflicts.length > 0) process.exitCode = 1;
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
