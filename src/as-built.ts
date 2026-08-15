import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  defaultAgentRunner,
  describeAgent,
  resolveAgent,
  tail,
  type AgentRunner,
} from "./agent-runner.js";
import {
  resolveSummary,
  summaryContract,
  summaryLine,
} from "./agent-summary.js";
import { loadPipelineConfig, type PipelineConfig } from "./pipeline-config.js";

/**
 * Snapshot the system that was actually built.
 *
 * Runs the build `agent`, not the author or validator: this is a codebase
 * scan and a piece of writing, not a judgment about someone else's work, and
 * the cheaper model configured for implementation is the right one for it.
 *
 * The archive copy is made by the runner rather than the agent. Copying a
 * file to a versioned path is deterministic, and asking a model to do
 * deterministic work is how you end up with a snapshot that silently differs
 * from its archive.
 */

const AS_BUILT_BRIEF = `
Update the as-built snapshot of this system after a completed program.

**Document reality, not the plan.** Read actual source files and catalog what
exists. Where the implementation differs from what the program document said
would be built, the implementation is what is true.

## What to read

Do not read every file. Read the load-bearing ones and extrapolate carefully
from evidence:

- Entry points and barrel files (\`index.ts\`, \`__init__.py\`, \`mod.rs\`) for
  the key exports of each package or module.
- Schema files for the data model: database schemas, SQL migrations, ORM
  models.
- Route registrations for API endpoints.
- Type definitions for protocols, events, and shared contracts.
- Infrastructure configuration: Dockerfiles, CI workflows, IaC modules.

## What to write

Write \`docs/as-built.md\` with this structure:

\`\`\`markdown
# {Project Name} — As-Built System Snapshot
<!-- Last updated: {YYYY-MM-DD} after program: {program-id} -->

## Packages & Key Exports
[For each package or module: name, path, 5-10 key exports. Not exhaustive —
the public API surface.]

## Data Model
[Tables or entities with column names and types. For schema-less stores,
document the document shapes.]

## API Endpoints
[Method, path, one-line purpose. Grouped by domain.]

## Protocols / Events
[Stream events, message types, pub-sub channels.]

## Infrastructure
[CI pipelines, Docker, IaC modules, deployment targets — what is configured.]

## Known Limitations / Tech Debt
[Stubs, missing features, follow-up needs. These become candidates for future
programs.]

## Programs Completed
[Ordered list of completed program IDs with a one-line summary and date.]
\`\`\`

## Rules

- Keep it between roughly 200 and 300 lines. It is a curated index, not a code
  dump.
- Preserve the existing "Programs Completed" history and append to it; do not
  drop entries for programs you did not witness.
- Someone reading only the vision document and this snapshot must be able to
  plan the next program. That is the bar.
- Write \`docs/as-built.md\` and nothing else. Do not commit, and do not
  archive a copy — the runner does that itself.
`.trim();

export interface AsBuiltOptions {
  cwd: string;
  programId: string;
  agentRunner?: AgentRunner;
  onProgress?: (line: string) => void;
}

export interface AsBuiltResult {
  programId: string;
  result: "COMPLETE" | "ABORTED";
  reason?: string;
  /** The resolved agent, when configured. */
  agent?: string;
  snapshotPath?: string;
  archivePath?: string;
  /** The agent's own account of the snapshot, verbatim. */
  summary?: string;
  promptBytes?: number;
}

export function snapshotPathFor(root: string): string {
  return join(root, "docs", "as-built.md");
}

export function archivePathFor(root: string, programId: string): string {
  return join(root, "docs", "snapshots", `as-built-${programId}.md`);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function updateAsBuilt(
  options: AsBuiltOptions,
): Promise<AsBuiltResult> {
  const root = resolve(options.cwd);
  const runAgent = options.agentRunner ?? defaultAgentRunner;
  const progress = options.onProgress ?? ((): void => {});

  const aborted = (reason: string): AsBuiltResult => ({
    programId: options.programId,
    result: "ABORTED",
    reason,
  });

  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(root);
  } catch (error) {
    return aborted(error instanceof Error ? error.message : String(error));
  }

  const agent = resolveAgent(config);
  if (!agent) {
    return aborted(
      'No agent configured; add an "agent" block to pipeline.config.json or set PROGRAM_PIPELINE_AGENT_COMMAND.',
    );
  }
  const agentLabel = describeAgent(agent);
  progress(`agents: snapshot ${agentLabel}`);

  const snapshotPath = snapshotPathFor(root);
  const existing = await readOptional(snapshotPath);
  const programDoc = await readOptional(
    join(root, "docs", "programs", `${options.programId}-program.md`),
  );
  const agentsMd = await readOptional(join(root, "AGENTS.md"));

  const prompt = [
    `# Update the as-built snapshot after program ${options.programId}`,
    "",
    AS_BUILT_BRIEF,
    "",
    "## Material",
    "",
    existing
      ? `### Current docs/as-built.md\n\n\`\`\`markdown\n${existing}\n\`\`\`\n`
      : "### Current docs/as-built.md\n\nNone yet — this is the first snapshot.\n",
    programDoc
      ? `### Program document\n\n\`\`\`\n${programDoc}\n\`\`\`\n`
      : "",
    agentsMd ? `### AGENTS.md\n\n\`\`\`\n${agentsMd}\n\`\`\`\n` : "",
    "",
    summaryContract(),
  ]
    .filter((part) => part !== "")
    .join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  progress(`scanning the codebase for ${options.programId}`);
  const result = await runAgent({
    command: agent.command,
    args: agent.args,
    prompt,
    promptMode: agent.promptMode,
    cwd: root,
  });

  const summary = resolveSummary(result.output);
  progress(`snapshot agent says: ${summaryLine(summary)}`);

  if (result.inputError) {
    return {
      ...aborted(
        `The prompt could not be delivered to the agent's stdin (${result.inputError}); the agent likely ran without instructions.`,
      ),
      agent: agentLabel,
      summary: summary.text,
      promptBytes,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ...aborted(
        `Snapshot agent (${agentLabel}) exited ${result.exitCode}: ${tail(result.output, 800)}`,
      ),
      agent: agentLabel,
      summary: summary.text,
      promptBytes,
    };
  }
  // The same no-op guard the other runners apply: an agent that exits clean
  // without writing the file has not produced a snapshot.
  if (!(await pathExists(snapshotPath))) {
    return {
      ...aborted(
        `The agent exited successfully but docs/as-built.md does not exist.`,
      ),
      agent: agentLabel,
      summary: summary.text,
      promptBytes,
    };
  }

  const archivePath = archivePathFor(root, options.programId);
  await mkdir(dirname(archivePath), { recursive: true });
  await copyFile(snapshotPath, archivePath);
  progress(`archived to ${archivePath}`);

  return {
    programId: options.programId,
    result: "COMPLETE",
    agent: agentLabel,
    snapshotPath,
    archivePath,
    summary: summary.text,
    promptBytes,
  };
}
