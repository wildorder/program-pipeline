import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocation, CommandResult } from "../src/agent-runner.js";
import {
  authorWorkstreams,
  fitDependencySpecs,
  parseDeclaration,
  readScope,
} from "../src/author-workstreams.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function spec(workstreamId: string, body = ""): string {
  return `# ${workstreamId}: Example

## Traceability
- SC-01

## Files Touched
- \`src/example.ts\` (NEW)

## Tests
1. Scenario: valid input. Expected: accepted. Assert: result passes.

## Acceptance Criteria
1. Verification exits successfully.
${body}`;
}

const scopeFor = (id: string) => ({
  summary: `${id} does its own job.`,
  includes: [`${id} inclusion`],
  excludes: [`${id} exclusion`],
});

interface FixtureOptions {
  /** Omit scope from these workstream IDs. */
  unscoped?: string[];
  /** Pre-write these spec files before the run. */
  existingSpecs?: string[];
  author?: Record<string, unknown>;
  authorAgent?: Record<string, unknown> | null;
}

/**
 * Three workstreams shaped as two levels: WS-01 and WS-02 are independent,
 * WS-03 depends on both.
 */
async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-author-"));
  temporaryRoots.push(root);

  const unscoped = new Set(options.unscoped ?? []);
  const workstreams = [
    { id: "WS-01", name: "Core", dependencies: [] as string[] },
    { id: "WS-02", name: "Storage", dependencies: [] as string[] },
    { id: "WS-03", name: "API", dependencies: ["WS-01", "WS-02"] },
  ].map((workstream) => ({
    ...workstream,
    taskFile: `tasks/alpha/${workstream.id.toLowerCase()}.md`,
    status: "not_started",
    ...(unscoped.has(workstream.id) ? {} : { scope: scopeFor(workstream.id) }),
  }));

  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(
      {
        program: { id: "alpha", name: "Alpha", status: "planning" },
        successCriteria: [{ id: "SC-01", description: "Feature works." }],
        workstreams,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n\nProgram document.\n",
    "utf8",
  );
  await writeFile(join(root, "AGENTS.md"), "# Agent Directives\n", "utf8");
  for (const taskFile of options.existingSpecs ?? []) {
    await writeFile(join(root, taskFile), spec("EXISTING"), "utf8");
  }
  await writeFile(
    join(root, "pipeline.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pipelineVersion: "0.1.0",
        visionPath: "docs/vision.md",
        requireApprovalBeforeBuild: false,
        agent: { command: "build-agent", args: [] },
        ...(options.authorAgent === null
          ? {}
          : {
              authorAgent: options.authorAgent ?? {
                command: "author-agent",
                args: ["--model", "opus"],
              },
            }),
        validatorAgent: { command: "codex", args: ["exec"] },
        verify: { test: "npm test" },
        ...(options.author ? { author: options.author } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

const targetOf = (prompt: string): { id: string; taskFile: string } => ({
  id: prompt.match(/Author the workstream spec for (WS-\d+)/u)?.[1] ?? "",
  taskFile: prompt.match(/Write the spec to `([^`]+)`/u)?.[1] ?? "",
});

/** A fake author that writes the requested spec and declares nothing. */
function writesSpecs(
  root: string,
  declaration: Record<string, unknown> = {},
  capture?: Map<string, string>,
) {
  return async (invocation: AgentInvocation): Promise<CommandResult> => {
    const { id, taskFile } = targetOf(invocation.prompt);
    capture?.set(id, invocation.prompt);
    if (taskFile) {
      await mkdir(dirname(join(root, taskFile)), { recursive: true });
      await writeFile(join(root, taskFile), spec(id), "utf8");
    }
    const body = JSON.stringify({
      dependencies: [],
      needs: [],
      unmet: [],
      ...declaration,
    });
    return {
      exitCode: 0,
      output: `\`\`\`json\n${body}\n\`\`\`\n\n\`\`\`summary\nWrote ${id}.\n\`\`\`\n`,
    };
  };
}

/** A fake author that returns a fixed declaration per workstream. */
function declaringAgent(
  root: string,
  declarations: Record<string, Record<string, unknown>>,
) {
  return async (invocation: AgentInvocation): Promise<CommandResult> => {
    const { id, taskFile } = targetOf(invocation.prompt);
    if (taskFile) {
      await mkdir(dirname(join(root, taskFile)), { recursive: true });
      await writeFile(join(root, taskFile), spec(id), "utf8");
    }
    const body = JSON.stringify({
      dependencies: [],
      needs: [],
      unmet: [],
      ...(declarations[id] ?? {}),
    });
    return {
      exitCode: 0,
      output: `\`\`\`json\n${body}\n\`\`\`\n\n\`\`\`summary\nWrote ${id}.\n\`\`\`\n`,
    };
  };
}

async function dependenciesOf(root: string, id: string): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(
      join(root, "docs", "programs", "alpha-manifest.json"),
      "utf8",
    ),
  ) as { workstreams: Array<{ id: string; dependencies: string[] }> };
  return manifest.workstreams.find((entry) => entry.id === id)?.dependencies ?? [];
}

describe("readScope", () => {
  it("treats a workstream with no summary as unscoped", () => {
    expect(readScope(undefined)).toBeUndefined();
    expect(readScope({ includes: ["a"] })).toBeUndefined();
    expect(readScope({ summary: "   " })).toBeUndefined();
  });

  it("normalizes includes and excludes", () => {
    expect(
      readScope({
        summary: "  Does a thing.  ",
        includes: ["  a  ", "", "a"],
        excludes: ["b"],
      }),
    ).toEqual({ summary: "Does a thing.", includes: ["a"], excludes: ["b"] });
  });
});

describe("parseDeclaration", () => {
  it("reads the three lists out of a fenced json block", () => {
    const output = `\`\`\`json
{ "dependencies": ["WS-03"], "needs": ["WS-12"], "unmet": ["rotation"] }
\`\`\``;
    expect(parseDeclaration(output)).toEqual({
      dependencies: ["WS-03"],
      needs: ["WS-12"],
      unmet: ["rotation"],
    });
  });

  it("drops anything that is not a workstream id from the id lists", () => {
    const output = `\`\`\`json
{ "dependencies": ["WS-03", "the storage layer", "ws-4", 7], "needs": ["WS-1"] }
\`\`\``;
    // A malformed edge must not reach the manifest, and WS ids need two digits.
    expect(parseDeclaration(output)).toEqual({
      dependencies: ["WS-03"],
      needs: [],
      unmet: [],
    });
  });

  it("returns empty lists when the agent emitted no json", () => {
    expect(parseDeclaration("I wrote the spec.")).toEqual({
      dependencies: [],
      needs: [],
      unmet: [],
    });
  });

  it("deduplicates repeated ids", () => {
    const output = '```json\n{ "dependencies": ["WS-03", "WS-03"] }\n```';
    expect(parseDeclaration(output).dependencies).toEqual(["WS-03"]);
  });
});

describe("fitDependencySpecs", () => {
  const make = (id: string, size: number) => ({
    id,
    path: `${id}.md`,
    content: "x".repeat(size),
  });

  it("keeps everything when the budget allows", () => {
    const specs = [make("WS-01", 10), make("WS-02", 10)];
    expect(fitDependencySpecs(specs, 100)).toEqual({
      kept: specs,
      demoted: [],
    });
  });

  it("drops the largest first so the most specs survive", () => {
    const result = fitDependencySpecs(
      [make("WS-01", 10), make("WS-02", 500), make("WS-03", 10)],
      100,
    );
    expect(result.kept.map(({ id }) => id)).toEqual(["WS-01", "WS-03"]);
    expect(result.demoted).toEqual(["WS-02"]);
  });

  it("can demote every spec when one alone exceeds the budget", () => {
    const result = fitDependencySpecs([make("WS-01", 5000)], 100);
    expect(result.kept).toEqual([]);
    expect(result.demoted).toEqual(["WS-01"]);
  });
});

describe("authorWorkstreams", () => {
  it("refuses to author when a workstream has no scope", async () => {
    const root = await fixture({ unscoped: ["WS-02", "WS-03"] });
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });

    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("WS-02, WS-03");
    expect(report.reason).toContain("/plan-program");
    expect(report.outcomes).toEqual([]);
  });

  it("groups workstreams into dependency levels on --dry-run", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      dryRun: true,
      agentRunner: async () => {
        throw new Error("must not spawn on a dry run");
      },
    });

    expect(report.result).toBe("PLANNED");
    expect(report.levels).toEqual([["WS-01", "WS-02"], ["WS-03"]]);
  });

  it("authors every workstream and writes each spec", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root),
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes.map(({ id, status }) => [id, status])).toEqual([
      ["WS-01", "authored"],
      ["WS-02", "authored"],
      ["WS-03", "authored"],
    ]);
    await expect(
      readFile(join(root, "tasks", "alpha", "ws-03.md"), "utf8"),
    ).resolves.toContain("WS-03");
  });

  it("gives every author the full roster, including unrelated workstreams", async () => {
    const root = await fixture();
    const prompts = new Map<string, string>();
    await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root, {}, prompts),
    });

    // WS-01 depends on nothing, yet must still be able to see that WS-02 and
    // WS-03 exist — otherwise it reimplements their work.
    const brief = prompts.get("WS-01") ?? "";
    expect(brief).toContain("WS-02: Storage");
    expect(brief).toContain("WS-03: API");
    expect(brief).toContain("WS-02 inclusion");
    expect(brief).toContain("WS-02 exclusion");
    expect(brief).toContain("what exists");
  });

  it("gives a dependent workstream its dependencies' finished specs", async () => {
    const root = await fixture();
    const prompts = new Map<string, string>();
    await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root, {}, prompts),
    });

    const brief = prompts.get("WS-03") ?? "";
    expect(brief).toContain("Your dependencies, in full");
    expect(brief).toContain("tasks/alpha/ws-01.md");
    expect(brief).toContain("tasks/alpha/ws-02.md");
    // The dependency specs were written during this same run, by level one.
    expect(brief).toContain("# WS-01: Example");
    expect(brief).toContain("# WS-02: Example");
  });

  it("does not leak a sibling's spec into an independent workstream's brief", async () => {
    const root = await fixture();
    const prompts = new Map<string, string>();
    await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root, {}, prompts),
    });

    expect(prompts.get("WS-01") ?? "").not.toContain(
      "Your dependencies, in full",
    );
  });

  it("records the declaration the author returned", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root, {
        dependencies: ["WS-01"],
        needs: ["WS-02"],
        unmet: ["token rotation"],
      }),
    });

    expect(report.outcomes[0]?.declaration).toEqual({
      dependencies: ["WS-01"],
      needs: ["WS-02"],
      unmet: ["token rotation"],
    });
    expect(report.outcomes[0]?.summary).toBe("Wrote WS-01.");
  });

  it("skips specs that already exist and re-authors them with --force", async () => {
    const root = await fixture({
      existingSpecs: ["tasks/alpha/ws-01.md"],
    });
    const skipped = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root),
    });
    expect(
      skipped.outcomes.find(({ id }) => id === "WS-01"),
    ).toMatchObject({ status: "skipped", reason: "spec already exists" });
    await expect(
      readFile(join(root, "tasks", "alpha", "ws-01.md"), "utf8"),
    ).resolves.toContain("EXISTING");

    const forced = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      force: true,
      agentRunner: writesSpecs(root),
    });
    expect(forced.outcomes.find(({ id }) => id === "WS-01")?.status).toBe(
      "authored",
    );
    await expect(
      readFile(join(root, "tasks", "alpha", "ws-01.md"), "utf8"),
    ).resolves.toContain("WS-01");
  });

  it("authors only the selected workstreams with --only", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      only: ["WS-02"],
      agentRunner: writesSpecs(root),
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.outcomes.map(({ id }) => id)).toEqual(["WS-02"]);
  });

  it("fails a workstream when the agent exits clean but writes no spec", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "all done!" }),
    });

    expect(report.result).toBe("FAILED");
    expect(report.outcomes[0]).toMatchObject({ status: "failed" });
    expect(report.outcomes[0]?.reason).toContain("does not exist");
  });

  it("stops before the next level when a level fails", async () => {
    const root = await fixture();
    const seen: string[] = [];
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        const { id } = targetOf(invocation.prompt);
        seen.push(id);
        return { exitCode: 1, output: "usage limit reached" };
      },
    });

    expect(report.result).toBe("FAILED");
    // Level two must never author against specs level one failed to write.
    expect(seen).not.toContain("WS-03");
    expect(report.reason).toContain("later levels depend on these specs");
  });

  it("fails the attempt when the prompt could not be delivered", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root),
    });
    expect(report.result).toBe("COMPLETE");

    const undelivered = await fixture();
    const report2 = await authorWorkstreams({
      cwd: undelivered,
      programId: "alpha",
      agentRunner: async () => ({
        exitCode: 0,
        output: "",
        inputError: "EPIPE",
      }),
    });
    expect(report2.result).toBe("FAILED");
    expect(report2.outcomes[0]?.reason).toContain("EPIPE");
  });

  it("demotes oversized dependency specs to the roster and says so", async () => {
    const root = await fixture({ author: { maxDependencySpecChars: 1000 } });
    const prompts = new Map<string, string>();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        const { id, taskFile } = targetOf(invocation.prompt);
        prompts.set(id, invocation.prompt);
        if (taskFile) {
          await writeFile(
            join(root, taskFile),
            spec(id, "x".repeat(2000)),
            "utf8",
          );
        }
        return { exitCode: 0, output: '```json\n{}\n```' };
      },
    });

    expect(report.result).toBe("COMPLETE");
    const third = report.outcomes.find(({ id }) => id === "WS-03");
    expect(third?.demoted?.length).toBeGreaterThan(0);
    expect(prompts.get("WS-03") ?? "").toContain("name it in `needs`");
  });

  it("aborts when no authoring agent is configured", async () => {
    const root = await fixture({ authorAgent: null });
    await writeFile(
      join(root, "pipeline.config.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pipelineVersion: "0.1.0",
          visionPath: "docs/vision.md",
          requireApprovalBeforeBuild: false,
          verify: { test: "npm test" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: "" }),
    });
    expect(report.result).toBe("ABORTED");
    expect(report.reason).toContain("authorAgent");
  });

  it("merges the dependency edges its authors declared into the manifest", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: declaringAgent(root, {
        "WS-01": { dependencies: ["WS-02"] },
      }),
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.reconciliation[0]?.added).toEqual([
      { workstreamId: "WS-01", dependsOn: "WS-02" },
    ]);
    await expect(dependenciesOf(root, "WS-01")).resolves.toEqual(["WS-02"]);
  });

  it("re-authors a workstream that asked for a spec it did not have", async () => {
    const root = await fixture();
    const prompts: Array<{ id: string; prompt: string }> = [];
    const seen: string[] = [];

    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        const { id, taskFile } = targetOf(invocation.prompt);
        prompts.push({ id, prompt: invocation.prompt });
        seen.push(id);
        await writeFile(join(root, taskFile), spec(id), "utf8");
        // WS-01 and WS-02 are siblings, so WS-01 authors without ever seeing
        // WS-02's spec. It asks for it once, then settles.
        const firstTime = seen.filter((entry) => entry === id).length === 1;
        const declaration =
          id === "WS-01" && firstTime ? { needs: ["WS-02"] } : {};
        return {
          exitCode: 0,
          output: `\`\`\`json\n${JSON.stringify({
            dependencies: [],
            needs: [],
            unmet: [],
            ...declaration,
          })}\n\`\`\`\n\n\`\`\`summary\nWrote ${id}.\n\`\`\`\n`,
        };
      },
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.reconciliation[0]?.reauthored).toEqual(["WS-01"]);
    expect(report.reconciliation[1]?.reauthored).toEqual([]);
    await expect(dependenciesOf(root, "WS-01")).resolves.toEqual(["WS-02"]);

    // The re-run is the whole point: the second brief carries WS-02's spec,
    // which the first one could not have.
    const attempts = prompts.filter(({ id }) => id === "WS-01");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.prompt).not.toContain("Your dependencies, in full");
    expect(attempts[1]?.prompt).toContain("Your dependencies, in full");
    expect(attempts[1]?.prompt).toContain("# WS-02: Example");

    const passes = report.outcomes
      .filter(({ id }) => id === "WS-01")
      .map(({ pass }) => pass);
    expect(passes).toEqual([1, 2]);
  });

  it("requires a replan when merging the declared edges would cycle", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      // WS-03 already depends on WS-01, so this closes a loop.
      agentRunner: declaringAgent(root, {
        "WS-01": { dependencies: ["WS-03"] },
      }),
    });

    expect(report.result).toBe("REQUIRES_REPLAN");
    expect(report.cycles?.length).toBeGreaterThan(0);
    expect(report.reason).toContain("cycle");
    expect(report.reason).toContain("/plan-program");
    // A cyclic manifest is one neither validate nor build can order, so the
    // merge must not land.
    await expect(dependenciesOf(root, "WS-01")).resolves.toEqual([]);
  });

  it("requires a replan when a requirement has no workstream, but still merges edges", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: declaringAgent(root, {
        "WS-01": { dependencies: ["WS-02"] },
        "WS-02": { unmet: ["token rotation"] },
      }),
    });

    expect(report.result).toBe("REQUIRES_REPLAN");
    expect(report.unmet).toEqual([
      { workstreamId: "WS-02", requirement: "token rotation" },
    ]);
    expect(report.reason).toContain("token rotation");
    // The edges were valid regardless of the coverage gap.
    await expect(dependenciesOf(root, "WS-01")).resolves.toEqual(["WS-02"]);
  });

  it("gives up when authors keep asking for specs they already received", async () => {
    const root = await fixture({ author: { maxReconcilePasses: 2 } });
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: declaringAgent(root, {
        "WS-01": { needs: ["WS-02"] },
      }),
    });

    expect(report.result).toBe("FAILED");
    expect(report.reason).toContain("still asked for dependency specs");
    expect(report.reason).toContain("WS-01");
    expect(report.reconciliation).toHaveLength(2);
  });

  it("ignores a declared edge naming a workstream that does not exist", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: declaringAgent(root, {
        "WS-01": { dependencies: ["WS-99"] },
      }),
    });

    expect(report.result).toBe("COMPLETE");
    expect(report.reconciliation[0]?.unknown).toEqual([
      { workstreamId: "WS-01", dependsOn: "WS-99" },
    ]);
    await expect(dependenciesOf(root, "WS-01")).resolves.toEqual([]);
  });

  it("records brief size per workstream as context telemetry", async () => {
    const root = await fixture();
    const report = await authorWorkstreams({
      cwd: root,
      programId: "alpha",
      agentRunner: writesSpecs(root),
    });

    for (const outcome of report.outcomes) {
      expect(outcome.promptBytes).toBeGreaterThan(0);
    }
    // WS-03 carries two dependency specs the others do not.
    const first = report.outcomes.find(({ id }) => id === "WS-01");
    const third = report.outcomes.find(({ id }) => id === "WS-03");
    expect(third?.promptBytes).toBeGreaterThan(first?.promptBytes ?? 0);
  });
});
