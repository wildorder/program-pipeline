import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replanProgram } from "../src/replan-program.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(criteriaPatches: unknown[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-replan-"));
  roots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await writeFile(join(root, "pipeline.config.json"), JSON.stringify({ schemaVersion: 1, pipelineVersion: "0.13.13", visionPath: "docs/vision.md", requireApprovalBeforeBuild: false, replannerAgent: { command: "planner", args: [] } }), "utf8");
  await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nold plan\n", "utf8");
  await writeFile(join(root, "docs", "programs", "alpha-manifest.json"), JSON.stringify({ program: { id: "alpha", planGeneration: "g1" }, successCriteria: [{ id: "SC-01", description: "Old wording" }], workstreams: [] }), "utf8");
  const finding = { id: "f1", severity: "blocker", category: "acceptance-criteria", subject: "SC-01", message: "mismatch", evidence: [{ kind: "concern", named: "signature mismatch" }], requiresReplan: true };
  await writeFile(join(root, "docs", "programs", "alpha-replan.json"), JSON.stringify({ schemaVersion: 2, programId: "alpha", replanFindings: [finding], relatedFindings: [finding], classAnalyses: [{ subject: "SC-01", scope: "systemic", rootCause: "family mismatch", affectedSubjects: ["a"], checkedSubjects: ["a", "b"], completenessBasis: "registry" }], criteriaPatches }), "utf8");
  return root;
}

const proof = `\`\`\`json
{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"checkedSubjects":["a","b"],"completenessBasis":"complete registry"}]}
\`\`\`
\`\`\`summary
Closed the complete class. REPLAN_COMPLETE
\`\`\``;

describe("replanProgram", () => {
  it("requires a class-wide resolution proof", async () => {
    const root = await fixture();
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: "```summary\nREPLAN_COMPLETE\n```" };
      },
    });
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("resolution proof");
  });

  it("accepts an exact intent-preserving criterion patch with closure proof", async () => {
    const root = await fixture([{ criterionId: "SC-01", kind: "clarification", intentPreserved: true, before: "Old wording", after: "Clarified wording", reason: "matches actual signature shapes" }]);
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        const manifestPath = join(root, "docs", "programs", "alpha-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { program: { planGeneration: string }; successCriteria: Array<{ description: string }> };
        manifest.program.planGeneration = "g2";
        manifest.successCriteria[0]!.description = "Clarified wording";
        await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
        return { exitCode: 0, output: proof };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(result.generation).toBe("g2");
  });
});
