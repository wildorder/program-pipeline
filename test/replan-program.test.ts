import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replanProgram } from "../src/replan-program.js";
import { replanInputHash } from "../src/replan-report.js";
import { loadPipelineConfig } from "../src/pipeline-config.js";

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
{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"a","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"corrected the canonical rule"}]},{"subject":"b","disposition":"already-correct","evidence":[{"path":"src/b.ts:10","detail":"already implements the corrected rule"}]}],"completenessBasis":"complete registry"}]}
\`\`\`
\`\`\`summary
Closed the complete class. REPLAN_COMPLETE
\`\`\``;

describe("replanProgram", () => {
  it("refuses a report whose hashed canonical inputs have drifted", async () => {
    const root = await fixture();
    const reportPath = join(root, "docs", "programs", "alpha-replan.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.inputHash = await replanInputHash(root, "alpha", await loadPipelineConfig(root));
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nhuman edit\n", "utf8");
    let calls = 0;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        calls += 1;
        return { exitCode: 0, output: proof };
      },
    });
    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("report is stale");
    expect(calls).toBe(0);
    await expect(readFile(join(root, "docs", "programs", "alpha-program.md"), "utf8"))
      .resolves.toBe("# Alpha\nhuman edit\n");
  });

  it("refuses to automatically replan a human-required report", async () => {
    const root = await fixture();
    const reportPath = join(root, "docs", "programs", "alpha-replan.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.outcome = "human-required";
    report.humanDecisionReason = "Either authorize publication or stop claiming the rung is built.";
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    let calls = 0;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        calls += 1;
        return { exitCode: 0, output: proof };
      },
    });
    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("human requirements decision");
    expect(result.reason).toContain("/plan-program alpha");
    expect(result.reason).toContain("authorize publication");
    expect(calls).toBe(0);
  });

  it("requires a class-wide resolution proof", async () => {
    const root = await fixture();
    let calls = 0;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        calls += 1;
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        const manifestPath = join(root, "docs", "programs", "alpha-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { program: { planGeneration: string } };
        manifest.program.planGeneration = "rejected-generation";
        await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
        return { exitCode: 0, output: "```summary\nREPLAN_COMPLETE\n```" };
      },
    });
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("resolutionProofs");
    expect(calls).toBe(2);
    await expect(readFile(join(root, "docs", "programs", "alpha-program.md"), "utf8"))
      .resolves.toBe("# Alpha\nold plan\n");
    const restoredManifest = JSON.parse(await readFile(join(root, "docs", "programs", "alpha-manifest.json"), "utf8")) as { program: { planGeneration: string } };
    expect(restoredManifest.program.planGeneration).toBe("g1");
    const report = JSON.parse(await readFile(join(root, "docs", "programs", "alpha-replan.json"), "utf8")) as {
      schemaVersion: number;
      lastAttempt: { outcome: string; reason: string; failedSubjects: string[]; artifactsLeftOnDisk: boolean };
      attemptHistory: unknown[];
    };
    expect(report.schemaVersion).toBe(5);
    expect(report.lastAttempt).toMatchObject({
      outcome: "rejected",
      artifactsLeftOnDisk: false,
    });
    expect(report.lastAttempt.reason).toContain("resolutionProofs");
    expect(report.attemptHistory).toHaveLength(2);
  });

  it("rolls back a rejected first attempt and feeds every proof defect into attempt two", async () => {
    const root = await fixture();
    let calls = 0;
    const prompts: string[] = [];
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        calls += 1;
        prompts.push(invocation.prompt);
        const programPath = join(root, "docs", "programs", "alpha-program.md");
        if (calls === 2) {
          await expect(readFile(programPath, "utf8")).resolves.toBe("# Alpha\nold plan\n");
        }
        await writeFile(programPath, "# Alpha\nnew plan\n", "utf8");
        return calls === 1
          ? { exitCode: 0, output: "```summary\nREPLAN_COMPLETE\n```" }
          : { exitCode: 0, output: proof };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("previous attempt was rejected and rolled back");
    expect(prompts[1]).toContain("no resolutionProofs contract");
    const report = JSON.parse(await readFile(join(root, "docs", "programs", "alpha-replan.json"), "utf8")) as {
      lastAttempt: { outcome: string };
      attemptHistory: Array<{ outcome: string }>;
    };
    expect(report.lastAttempt.outcome).toBe("accepted");
    expect(report.attemptHistory.map(({ outcome }) => outcome)).toEqual(["rejected", "accepted"]);
  });

  it("reports all class members missing dispositions in one rejection", async () => {
    const root = await fixture();
    const partial = `\`\`\`json
{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"a","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"fixed a"}]}],"completenessBasis":"registry"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: partial };
      },
    });
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("missing/duplicate: P1.2 b");
    const report = JSON.parse(await readFile(join(root, "docs", "programs", "alpha-replan.json"), "utf8")) as {
      lastAttempt: { failedSubjects: string[]; resolutionProofs: unknown[] };
    };
    expect(report.lastAttempt.failedSubjects).toEqual(["SC-01"]);
    expect(report.lastAttempt.resolutionProofs).toHaveLength(1);
  });

  it("reports every subject with a missing proof in one verdict", async () => {
    const root = await fixture();
    const reportPath = join(root, "docs", "programs", "alpha-replan.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      replanFindings: Array<Record<string, unknown>>;
      relatedFindings: Array<Record<string, unknown>>;
      classAnalyses: Array<Record<string, unknown>>;
    };
    const second = { ...report.replanFindings[0], id: "f2", subject: "SC-02" };
    report.replanFindings.push(second);
    report.relatedFindings.push(second);
    report.classAnalyses.push({ subject: "SC-02", scope: "systemic", rootCause: "second mismatch", affectedSubjects: ["c"], checkedSubjects: ["c", "d"], completenessBasis: "second registry" });
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: "```json\n{\"resolutionProofs\":[]}\n```\n```summary\nREPLAN_COMPLETE\n```" };
      },
    });
    expect(result.reason).toContain("SC-01");
    expect(result.reason).toContain("SC-02");
    const persisted = JSON.parse(await readFile(reportPath, "utf8")) as { lastAttempt: { failedSubjects: string[] } };
    expect(persisted.lastAttempt.failedSubjects).toEqual(["SC-01", "SC-02"]);
  });

  it("accepts an ID-keyed proof referencing the report's obligation roster", async () => {
    const root = await fixture();
    const reportPath = join(root, "docs", "programs", "alpha-replan.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.proofObligations = [{
      id: "P1",
      subject: "SC-01",
      members: [
        { id: "P1.1", text: "a", affected: true },
        { id: "P1.2", text: "b", affected: false },
      ],
    }];
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    const keyed = `\`\`\`json
{"resolutionProofs":[{"obligation":"P1","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"member":"P1.1","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"corrected the canonical rule"}]},{"member":"P1.2","disposition":"already-correct","evidence":[{"path":"src/b.ts:10","detail":"already implements the corrected rule"}]}],"completenessBasis":"complete registry"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    const prompts: string[] = [];
    let calls = 0;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        calls += 1;
        prompts.push(invocation.prompt);
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: keyed };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(calls).toBe(1);
    expect(prompts[0]).toContain("P1.1 [affected — must be fixed]: a");
    expect(prompts[0]).toContain("P1.2: b");
  });

  it("derives the same obligation IDs for a legacy report and names them in rejections", async () => {
    const root = await fixture();
    const wrongDisposition = `\`\`\`json
{"resolutionProofs":[{"obligation":"P1","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"member":"P1.1","disposition":"already-correct","evidence":[{"path":"src/a.ts:1","detail":"claims correct"}]},{"member":"P1.2","disposition":"already-correct","evidence":[{"path":"src/b.ts:10","detail":"already correct"}]}],"completenessBasis":"registry"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: wrongDisposition };
      },
    });
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("affected subjects must be dispositioned fixed: P1.1 a");
  });

  it("matches proof and disposition subjects across case and punctuation differences", async () => {
    const root = await fixture();
    const fuzzy = `\`\`\`json
{"resolutionProofs":[{"subject":"sc-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"A.","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"corrected the canonical rule"}]},{"subject":"\`b\`","disposition":"already-correct","evidence":[{"path":"src/b.ts:10","detail":"already implements the corrected rule"}]}],"completenessBasis":"complete registry"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    let calls = 0;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        calls += 1;
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: fuzzy };
      },
    });
    expect(result.result).toBe("COMPLETE");
    expect(calls).toBe(1);
  });

  it("accepts an already-correct-only subject with no changed paths and ignores surplus proofs", async () => {
    const root = await fixture();
    const reportPath = join(root, "docs", "programs", "alpha-replan.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { classAnalyses: Array<Record<string, unknown>> };
    report.classAnalyses.push({ subject: "SC-02", scope: "isolated", rootCause: "suspected drift", affectedSubjects: [], checkedSubjects: ["e"], completenessBasis: "single member" });
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    const output = `\`\`\`json
{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"a","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"corrected the canonical rule"}]},{"subject":"b","disposition":"already-correct","evidence":[{"path":"src/b.ts:10","detail":"already implements the corrected rule"}]}],"completenessBasis":"complete registry"},{"subject":"SC-02","changedPaths":[],"dispositions":[{"subject":"e","disposition":"already-correct","evidence":[{"path":"src/e.ts:5","detail":"already matches the plan"}]}],"completenessBasis":"single member"},{"subject":"SC-99","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[],"completenessBasis":"surplus rigor"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output };
      },
    });
    expect(result.result).toBe("COMPLETE");
  });

  it("names the disposition lacking evidence instead of reporting the subject missing", async () => {
    const root = await fixture();
    const noEvidence = `\`\`\`json
{"resolutionProofs":[{"subject":"SC-01","changedPaths":["docs/programs/alpha-program.md"],"dispositions":[{"subject":"a","disposition":"fixed","evidence":[{"path":"docs/programs/alpha-program.md","detail":"fixed a"}]},{"subject":"b","disposition":"already-correct","evidence":[]}],"completenessBasis":"registry"}]}
\`\`\`
\`\`\`summary
REPLAN_COMPLETE
\`\`\``;
    const result = await replanProgram({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\nnew plan\n", "utf8");
        return { exitCode: 0, output: noEvidence };
      },
    });
    expect(result.result).toBe("FAILED");
    expect(result.reason).toContain("lack evidence");
    expect(result.reason).toContain("b");
    expect(result.reason).not.toContain("missing/duplicate");
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

describe("clearReplanReport", () => {
  it("archives the resolved report to history instead of deleting it", async () => {
    const { mkdtemp, mkdir, writeFile, readdir, readFile: read } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { clearReplanReport, replanReportPath, replanHistoryDir } =
      await import("../src/replan-report.js");
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-clear-"));
    await mkdir(join(root, "docs", "programs"), { recursive: true });
    const report = JSON.stringify({ programId: "alpha", outcome: "requires-replan" });
    await writeFile(replanReportPath(root, "alpha"), report, "utf8");

    await clearReplanReport(root, "alpha", () => new Date("2026-01-01T00:00:00Z"));

    await expect(read(replanReportPath(root, "alpha"), "utf8")).rejects.toThrow();
    const archived = await readdir(replanHistoryDir(root, "alpha"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain("resolved");
    expect(await read(join(replanHistoryDir(root, "alpha"), archived[0]!), "utf8")).toBe(report);
  });

  it("is a no-op when no report exists", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { clearReplanReport } = await import("../src/replan-report.js");
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-clear-"));
    await expect(clearReplanReport(root, "alpha")).resolves.toBeUndefined();
  });
});
