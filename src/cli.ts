#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { updateAsBuilt } from "./as-built.js";
import { authorWorkstreams } from "./author-workstreams.js";
import { buildProgram } from "./build-program.js";
import { reviewCriteria } from "./criteria.js";
import { reviewProgram } from "./review-program.js";
import {
  parseStage,
  runProgram,
  RUN_STAGES,
  type RunStage,
} from "./run-program.js";
import {
  addDevDependencyCommand,
  detectPackageManager,
  isPnpmWorkspaceRoot,
  PACKAGE_MANAGERS,
  parsePackageManager,
} from "./detect-package-manager.js";
import { initProject } from "./init-project.js";
import { initGitHubCi } from "./init-ci.js";
import {
  ALL_TARGETS,
  DEFAULT_TARGETS,
  detectTargets,
  doctor,
  installSkills,
  overrideEnvName,
  parseRootOverrides,
  parseTargets,
  type InstallSkillsResult,
} from "./install-skills.js";
import type { PreferredScope } from "./install-prefs.js";
import { installArgv, planSkillInstall } from "./install-wizard.js";
import { packageVersion } from "./package-assets.js";
import { createProjectManifest } from "./project-manifest.js";
import { countBySeverity, sortBySeverity } from "./findings.js";
import { validateLoop } from "./validate-loop.js";
import { validateWorkstreams } from "./validate.js";

/** Indent a possibly multi-line agent summary under its heading line. */
function indented(text: string, prefix = "  "): string {
  return text
    .split(/\r?\n/u)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

const SCOPES = ["user", "project", "both"] as const;

function parseScope(value: string): PreferredScope {
  const scope = value.trim().toLowerCase();
  if (!(SCOPES as readonly string[]).includes(scope)) {
    throw new Error(
      `Unknown scope "${value}". Expected: ${SCOPES.join(", ")}.`,
    );
  }
  return scope as PreferredScope;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface SkillCommandOptions {
  cwd: string;
  targets?: string;
  scope?: string;
  root: string[];
  force: boolean;
  yes: boolean;
  prune?: boolean;
}

/** Shared option surface for `install` and `setup`. */
function withSkillOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Project directory", process.cwd())
    .option(
      "--targets <targets>",
      `Comma-separated targets: ${DEFAULT_TARGETS} (default: detected tools)`,
    )
    .option(
      "--scope <scope>",
      `Install location: ${SCOPES.join(", ")} (default: user)`,
    )
    .option(
      "--root <target=path>",
      "Override a target's skills root; repeatable",
      collect,
      [],
    )
    .option("--force", "Overwrite conflicting skill files", false)
    .option("--yes", "Accept detected defaults without prompting", false)
    .option("--prune", "Remove unmodified project-scope copies after a user-scope install")
    .option("--no-prune", "Keep project-scope copies");
}

function localCliPath(root: string): string {
  return join(
    root,
    "node_modules",
    "@wildorder",
    "program-pipeline",
    "dist",
    "cli.js",
  );
}

/**
 * Resolves the plan (prompting when a human is present), runs the install, and
 * reports it. Returns undefined when the user cancelled or a conflict aborted
 * the write.
 */
async function runSkillInstall(
  options: SkillCommandOptions,
  command: Command,
): Promise<InstallSkillsResult | undefined> {
  const roots = parseRootOverrides(options.root);
  const plan = await planSkillInstall({
    cwd: options.cwd,
    ...(options.targets === undefined
      ? {}
      : { explicitTargets: parseTargets(options.targets) }),
    ...(options.scope === undefined
      ? {}
      : { explicitScope: parseScope(options.scope) }),
    // Commander gives --prune a value either way, so ask where it came from.
    ...(command.getOptionValueSource("prune") === "cli"
      ? { explicitPrune: options.prune ?? false }
      : {}),
    roots,
    yes: options.yes,
  });

  if (plan.cancelled) {
    console.log("cancelled; nothing was written");
    process.exitCode = 130;
    return undefined;
  }

  const result = await installSkills({
    cwd: options.cwd,
    targets: plan.targets,
    scopes: plan.scopes,
    force: options.force,
    pruneProject: plan.pruneProject,
    roots,
  });
  reportInstall(result);
  return result.aborted ? undefined : result;
}

function reportInstall(result: InstallSkillsResult): void {
  for (const path of result.installed) console.log(`installed ${path}`);
  for (const path of result.updated) console.log(`updated ${path}`);
  for (const path of result.skipped) console.log(`unchanged ${path}`);
  for (const path of result.pruned) console.log(`removed ${path}`);
  for (const path of result.retired) {
    console.log(`retired ${path}; its work is now a CLI command`);
  }
  for (const path of result.retiredKept) {
    console.warn(
      `warning kept ${path}; this skill is retired but you edited it, so it was left alone. It still instructs an agent to do work that is now a command — delete it when you have salvaged anything you need.`,
    );
  }
  for (const path of result.pruneSkipped) {
    console.warn(
      `warning kept ${path}; edited since generation, so it still shadows the user-scope skill`,
    );
  }
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

withSkillOptions(
  program
    .command("install")
    .description(
      "Install portable workflow skills for the agent tools on this machine",
    ),
).action(async (options: SkillCommandOptions, command: Command) => {
  await runSkillInstall(options, command);
});

withSkillOptions(
  program
    .command("setup")
    .description(
      "One-step setup: add the package as a devDependency and install workflow skills",
    ),
)
  .option(
    "--pm <manager>",
    `Package manager for the devDependency: ${PACKAGE_MANAGERS.join(", ")} (default: detected from the repository)`,
  )
  .option(
    "--no-package-json",
    "Do not create a placeholder package.json when the directory has none",
  )
  .action(
    async (
      options: SkillCommandOptions & { pm?: string; packageJson: boolean },
      command: Command,
    ) => {
      const root = resolve(options.cwd);

      if (options.packageJson && !existsSync(join(root, "package.json"))) {
        const manifest = await createProjectManifest(root);
        if (manifest.created) {
          console.log(
            `created package.json (private placeholder, name "${manifest.name}")`,
          );
        } else if (manifest.reason === "foreign manifest") {
          console.warn(
            `warning ${manifest.foreignManifest} found; skipped creating a package.json for a non-Node project`,
          );
        }
      }

      let addedDependency = false;
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
              addDevDependencyCommand(manager, "@wildorder/program-pipeline", {
                pnpmWorkspaceRoot: isPnpmWorkspaceRoot(root),
              }),
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
        addedDependency = true;
      } else {
        console.warn(
          "warning no package.json found; skipped adding the devDependency (run the CLI via npx @wildorder/program-pipeline)",
        );
      }

      // The dependency install just replaced this package's own files on
      // disk, but this process is still running the code it loaded before
      // that happened. Continuing in-process applies the *old* version's
      // notion of which skills exist to the *new* version's files, which
      // breaks outright the moment a release adds or retires one. Hand off to
      // the CLI that was just installed.
      const upgraded = localCliPath(root);
      if (addedDependency && existsSync(upgraded)) {
        const exitCode = await new Promise<number>(
          (resolvePromise, rejectPromise) => {
            const child = spawn(
              process.execPath,
              [
                upgraded,
                ...installArgv(
                  { ...options, cwd: root },
                  command.getOptionValueSource("prune") === "cli",
                ),
              ],
              { cwd: root, stdio: "inherit", windowsHide: true },
            );
            child.on("error", rejectPromise);
            child.on("close", (code) => resolvePromise(code ?? 1));
          },
        );
        if (exitCode !== 0) {
          process.exitCode = exitCode;
          return;
        }
        console.log(
          "setup complete; run /init-project from your agent to continue",
        );
        return;
      }

      const result = await runSkillInstall({ ...options, cwd: root }, command);
      if (result) {
        console.log(
          "setup complete; run /init-project from your agent to continue",
        );
      }
    },
  );

const ci = program
  .command("ci")
  .description("Configure optional cloud execution for program runs");

ci.command("init")
  .description("Install a CI workflow without overwriting an existing one")
  .argument("[provider]", "CI provider", "github")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--setup-command <command>",
    "Project dependency setup command (default: detected from lockfiles)",
  )
  .option("--force", "Replace the existing generated workflow", false)
  .action(
    async (
      provider: string,
      options: { cwd: string; setupCommand?: string; force: boolean },
    ) => {
      if (provider.trim().toLowerCase() !== "github") {
        throw new Error(
          `Unknown CI provider "${provider}". Expected: github.`,
        );
      }
      const result = await initGitHubCi({
        cwd: options.cwd,
        force: options.force,
        ...(options.setupCommand === undefined
          ? {}
          : { setupCommand: options.setupCommand }),
      });
      console.log(`${result.result} ${result.path}`);
      if (result.agents.length > 0) {
        console.log(`agent commands: ${result.agents.join(", ")}`);
      }
      for (const warning of result.warnings) {
        console.warn(`warning ${warning}`);
      }
      console.log(
        "configure only the credentials used by this project in GitHub Actions settings:",
      );
      console.log(`  secrets: ${result.requiredSecrets.join(", ")}`);
      console.log(`  variables: ${result.requiredVariables.join(", ")}`);
      console.log(
        "commit the workflow, then run it from Actions > Program Pipeline",
      );
    },
  );

program
  .command("doctor")
  .description(
    "Verify packaged assets and print the resolved skills root for each target",
  )
  .option(
    "--root <target=path>",
    "Override a target's skills root; repeatable",
    collect,
    [],
  )
  .action(async (options: { root: string[] }) => {
    const detected = await detectTargets({ roots: parseRootOverrides(options.root) });
    const width = Math.max(...detected.map((entry) => entry.label.length));

    console.log("skills roots");
    for (const entry of detected) {
      const state = entry.detected ? "detected" : "not detected";
      console.log(
        `  ${entry.label.padEnd(width)}  ${entry.userRoot}  [${state}, ${entry.source}]`,
      );
    }
    console.log(
      `\noverride any row with --root <target>=<path> or ${overrideEnvName(
        ALL_TARGETS[0] ?? "claude",
      )}-style environment variables\n`,
    );

    const problems = await doctor();
    if (problems.length === 0) {
      console.log("Program Pipeline package is healthy.");
      return;
    }
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  });

program
  .command("run")
  .description(
    "Run the whole pipeline: author, validate, converge, criteria, build, snapshot",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--from <stage>",
    `Start at this stage: ${RUN_STAGES.join(", ")}`,
    parseStage,
  )
  .option("--to <stage>", "Stop after this stage", parseStage)
  .option("--review", "Include the advisory architecture review", false)
  .option("--no-commit", "Do not commit between stages")
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (
      programId: string,
      options: {
        cwd: string;
        from?: RunStage;
        to?: RunStage;
        review: boolean;
        commit: boolean;
        json: boolean;
      },
    ) => {
      const result = await runProgram({
        cwd: options.cwd,
        programId,
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.to === undefined ? {} : { to: options.to }),
        review: options.review,
        // Commander defaults --no-commit's value to true, so only an explicit
        // false is an override.
        ...(options.commit === false ? { commit: false } : {}),
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("");
        for (const stage of result.stages) {
          const commit = stage.commit ? ` (commit ${stage.commit})` : "";
          console.log(`${stage.stage}: ${stage.result}${commit}`);
        }
        console.log(`${result.result}: ${result.programId}`);
        if (result.reason) console.log(result.reason);
      }
      if (result.result === "FAILED") process.exitCode = 1;
      else if (result.result === "STOPPED") process.exitCode = 2;
    },
  );

program
  .command("author")
  .description(
    "Author every workstream spec for a program, one clean agent per workstream, walking dependency levels",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option(
    "--only <ids>",
    "Comma-separated workstream IDs to author",
    (value: string) =>
      value
        .split(",")
        .map((id) => id.trim().toUpperCase())
        .filter((id) => id !== ""),
  )
  .option("--force", "Re-author specs that already exist", false)
  .option("--dry-run", "Print the level plan without running anything", false)
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (
      programId: string,
      options: {
        cwd: string;
        only?: string[];
        force: boolean;
        dryRun: boolean;
        json: boolean;
      },
    ) => {
      const report = await authorWorkstreams({
        cwd: options.cwd,
        programId,
        ...(options.only === undefined ? {} : { only: options.only }),
        force: options.force,
        dryRun: options.dryRun,
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        if (report.agent) console.log(`agent ${report.agent}`);
        report.levels.forEach((level, index) => {
          console.log(`level ${index + 1}: ${level.join(", ")}`);
        });
        for (const outcome of report.outcomes) {
          const detail = outcome.reason ? ` (${outcome.reason})` : "";
          console.log(`${outcome.status} ${outcome.id}${detail}`);
          if (outcome.summary) console.log(indented(outcome.summary));
          const { dependencies, needs, unmet } = outcome.declaration;
          if (dependencies.length > 0) {
            console.log(indented(`declared dependencies: ${dependencies.join(", ")}`));
          }
          if (needs.length > 0) {
            console.log(indented(`needs specs for: ${needs.join(", ")}`));
          }
          if (unmet.length > 0) {
            console.log(indented(`unmet by any workstream: ${unmet.join("; ")}`));
          }
        }
        for (const pass of report.reconciliation) {
          if (pass.added.length > 0) {
            console.log(
              `pass ${pass.pass}: merged ${pass.added.length} undeclared dependency edge(s)`,
            );
            for (const edge of pass.added) {
              console.log(indented(`${edge.workstreamId} -> ${edge.dependsOn}`));
            }
          }
          if (pass.reauthored.length > 0) {
            console.log(
              `pass ${pass.pass}: re-authored ${pass.reauthored.join(", ")}`,
            );
          }
        }
        for (const cycle of report.cycles ?? []) {
          console.log(`cycle: ${cycle.join(" -> ")}`);
        }
        for (const { workstreamId, requirement } of report.unmet ?? []) {
          console.log(`unmet (${workstreamId}): ${requirement}`);
        }
        if (report.eventsPath) console.log(`events ${report.eventsPath}`);
        console.log(`${report.result}: ${report.programId}`);
        if (report.reason) console.log(report.reason);
      }
      if (
        report.result === "FAILED" ||
        report.result === "ABORTED" ||
        report.result === "REQUIRES_REPLAN"
      ) {
        process.exitCode = 1;
      }
    },
  );

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
  .option(
    "--no-commit",
    "Do not commit each verified workstream (overrides build.commit)",
  )
  .action(
    async (
      programId: string,
      options: {
        cwd: string;
        startFrom?: string;
        dryRun: boolean;
        yes: boolean;
        commit: boolean;
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
        // Commander defaults --no-commit's value to true, so only an explicit
        // false is an override; otherwise the config decides.
        ...(options.commit === false ? { commit: false } : {}),
        onProgress: (line) => console.log(line),
      });

      if (report.agent) console.log(`agent ${report.agent}`);
      for (const entry of report.plan) {
        const suffix =
          entry.action === "skip" ? ` (skip: ${entry.reason ?? "skipped"})` : "";
        console.log(`plan ${entry.id} ${entry.name}${suffix}`);
      }
      for (const outcome of report.outcomes) {
        const commit = outcome.commit ? ` (commit ${outcome.commit})` : "";
        console.log(
          `${outcome.status} ${outcome.id} after ${outcome.attempts} attempt(s)${commit}`,
        );
        if (outcome.summary) console.log(indented(outcome.summary));
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
  .command("converge")
  .description(
    "Run the author/critic convergence loop over a program's workstream specs",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--rounds <n>", "Rounds to run (max 3)", (value) => Number(value))
  .option("--strict", "Fail the gate on major findings")
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (
      programId: string,
      options: {
        cwd: string;
        rounds?: number;
        strict?: boolean;
        json: boolean;
      },
    ) => {
      const result = await validateLoop({
        cwd: options.cwd,
        programId,
        ...(options.rounds === undefined ? {} : { rounds: options.rounds }),
        ...(options.strict === undefined ? {} : { strict: options.strict }),
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const counts = countBySeverity(result.findings);
        console.log(`\n${result.result} (${result.outcome}): ${result.programId}`);
        if (result.agents) {
          console.log(
            `author: ${result.agents.author} | validator: ${result.agents.validator}`,
          );
        }
        if (result.reason) console.log(result.reason);
        console.log(
          `blocker=${counts.blocker} major=${counts.major} minor=${counts.minor} advisory=${counts.advisory}`,
        );
        // What each agent said it did. The findings list below records what
        // the critic flagged; this is the only place its reasoning survives.
        for (const round of result.rounds) {
          if (round.criticSummary) {
            console.log(`\nround ${round.round} critic (${round.critic}):`);
            console.log(indented(round.criticSummary));
          }
          if (round.writerSummary && round.writer) {
            console.log(`round ${round.round} writer (${round.writer}):`);
            console.log(indented(round.writerSummary));
          }
        }
        if (result.findings.length > 0) console.log("");
        for (const finding of sortBySeverity(result.findings)) {
          const scope = finding.workstreamId ? ` ${finding.workstreamId}` : "";
          const label = finding.code ?? finding.category;
          console.log(
            `[${finding.severity}]${scope} ${label}: ${finding.message}`,
          );
        }
        if (result.replanFindings.length > 0) {
          console.log("\nRequires replanning (no spec edit can fix these):");
          for (const finding of result.replanFindings) {
            console.log(`- ${finding.subject}: ${finding.message}`);
          }
          if (result.replanReport) {
            console.log(`Replan report: ${result.replanReport}`);
            console.log(
              `Run /plan-program ${result.programId}; it will consume this report automatically.`,
            );
          }
        }
        if (result.openDisagreements.length > 0) {
          console.log(
            "\nOpen disagreements (the writer declined, the critic re-raised — settle these yourself):",
          );
          for (const { finding, reason } of result.openDisagreements) {
            console.log(`- ${finding.subject}: ${finding.message}`);
            console.log(`  declined because: ${reason}`);
          }
        }
      }
      if (result.result === "FAILED") process.exitCode = 1;
    },
  );

program
  .command("review")
  .description(
    "Read-only architecture and integration review of a planned program",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (programId: string, options: { cwd: string; json: boolean }) => {
      const result = await reviewProgram({
        cwd: options.cwd,
        programId,
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.agent) console.log(`reviewer ${result.agent}`);
        if (result.summary) {
          console.log("\nreviewer's summary:");
          console.log(indented(result.summary));
        }
        if (result.findings.length > 0) console.log("");
        for (const finding of sortBySeverity(result.findings)) {
          const scope = finding.workstreamId ? ` ${finding.workstreamId}` : "";
          console.log(
            `[${finding.severity}]${scope} ${finding.subject}: ${finding.message}`,
          );
        }
        if (result.reportPath) console.log(`\nreport ${result.reportPath}`);
        console.log(`${result.result}: ${result.programId}`);
        if (result.reason) console.log(result.reason);
      }
      // A review reports; it does not pass or fail. Only an unusable review
      // (no validator, agent crash) is an error.
      if (result.result === "ABORTED") process.exitCode = 1;
    },
  );

program
  .command("as-built")
  .description(
    "Snapshot the system that was actually built, and archive it for the program",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (programId: string, options: { cwd: string; json: boolean }) => {
      const result = await updateAsBuilt({
        cwd: options.cwd,
        programId,
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.agent) console.log(`agent ${result.agent}`);
        if (result.summary) console.log(indented(result.summary));
        if (result.snapshotPath) console.log(`snapshot ${result.snapshotPath}`);
        if (result.archivePath) console.log(`archive ${result.archivePath}`);
        console.log(`${result.result}: ${result.programId}`);
        if (result.reason) console.log(result.reason);
      }
      if (result.result === "ABORTED") process.exitCode = 1;
    },
  );

program
  .command("criteria")
  .description(
    "Collect every workstream's acceptance criteria into one reviewable document, and record approval",
  )
  .argument("<program-id>", "Program ID")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--approve", "Record approval for the criteria as they stand", false)
  .option("--json", "Print a machine-readable report", false)
  .action(
    async (
      programId: string,
      options: { cwd: string; approve: boolean; json: boolean },
    ) => {
      const result = await reviewCriteria({
        cwd: options.cwd,
        programId,
        approve: options.approve,
        onProgress: (line) => {
          if (!options.json) console.log(line);
        },
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.documentPath) console.log(`document ${result.documentPath}`);
        if (result.hash) console.log(`hash ${result.hash}`);
        if (result.missing && result.missing.length > 0) {
          console.log(`no acceptance criteria: ${result.missing.join(", ")}`);
        }
        console.log(`${result.result}: ${result.programId}`);
        if (result.reason) console.log(result.reason);
      }
      if (result.result === "ABORTED") process.exitCode = 1;
      else if (result.result === "REVIEW_REQUIRED") process.exitCode = 2;
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
        const counts = countBySeverity(report.findings);
        console.log(`${report.result}: ${report.programId}`);
        console.log(
          `blocker=${counts.blocker} major=${counts.major} minor=${counts.minor} advisory=${counts.advisory}`,
        );
        for (const finding of sortBySeverity(report.findings)) {
          const scope = finding.workstreamId
            ? ` ${finding.workstreamId}`
            : "";
          const label = finding.code ?? finding.category;
          console.log(
            `[${finding.severity}]${scope} ${label}: ${finding.message}`,
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
