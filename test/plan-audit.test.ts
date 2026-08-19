import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditPlan } from "../src/plan-audit.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-plan-audit-"));
  roots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await writeFile(join(root, "docs", "programs", "alpha-program.md"), "# Alpha\n", "utf8");
  await writeFile(join(root, "docs", "programs", "alpha-manifest.json"), JSON.stringify({
    program: { id: "alpha", name: "Alpha", status: "planning" },
    successCriteria: [
      { id: "SC-01", description: "Every registered command accepts a target." },
      { id: "SC-02", description: "The program remains green." },
    ],
    workstreams: [{ id: "WS-01", name: "Core", taskFile: "tasks/alpha/ws-01.md", status: "not_started", dependencies: [], scope: { summary: "Core." } }],
  }), "utf8");
  await writeFile(join(root, "pipeline.config.json"), JSON.stringify({
    schemaVersion: 1,
    pipelineVersion: "0.13.13",
    visionPath: "docs/vision.md",
    requireApprovalBeforeBuild: false,
    validatorAgent: { command: "critic", args: [] },
  }), "utf8");
  return root;
}

const assessment = (criterionId: string) => ({
  criterionId,
  status: "satisfiable",
  reason: "verified against repository source",
  checkedSubjects: [criterionId === "SC-01" ? "command registry" : "verification commands"],
  completenessBasis: criterionId === "SC-01" ? "all entries in the command registry" : "all configured verification commands",
});

describe("auditPlan", () => {
  it("uses one correction-only retry for a malformed class analysis", async () => {
    const root = await fixture();
    const prompts: string[] = [];
    let calls = 0;
    const finding = { severity: "blocker", category: "acceptance-criteria", subject: "SC-01", message: "The criterion conflicts with the API.", evidence: [{ kind: "concern", named: "signature mismatch" }], requiresReplan: true };
    const response = (checkedSubjects: string[]) => `\`\`\`json\n${JSON.stringify({
      criterionAssessments: [assessment("SC-01"), assessment("SC-02")],
      findings: [finding],
      classAnalyses: [{ subject: "SC-01", scope: "systemic", rootCause: "signature family mismatch", affectedSubjects: ["command a"], checkedSubjects, completenessBasis: "complete command registry" }],
      requirementsChangeRequested: false,
      criteriaPatches: [],
    })}\n\`\`\``;
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        calls += 1;
        prompts.push(invocation.prompt);
        return { exitCode: 0, output: response(calls === 1 ? ["command b"] : ["command a", "command b"]) };
      },
    });
    expect(result.result).toBe("REQUIRES_REPLAN");
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("affectedSubjects absent from checkedSubjects: command a");
    expect(prompts[1]).toContain("Do not re-run the review");
    expect(result.criticLogs).toHaveLength(2);
  });

  it("aborts with exact diagnostics and both logs when correction remains malformed", async () => {
    const root = await fixture();
    const output = `\`\`\`json\n${JSON.stringify({
      criterionAssessments: [assessment("SC-01"), assessment("SC-02")],
      findings: [{ severity: "major", category: "acceptance-criteria", subject: "SC-01/SC-02", message: "Combined finding.", evidence: [{ kind: "concern", named: "combined subject" }], requiresReplan: true }],
      classAnalyses: [],
      requirementsChangeRequested: false,
      criteriaPatches: [],
    })}\n\`\`\``;
    let calls = 0;
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => {
        calls += 1;
        return { exitCode: 0, output };
      },
    });
    expect(result.result).toBe("ABORTED");
    expect(calls).toBe(2);
    expect(result.reason).toContain("compound criterion subjects are unstable");
    expect(result.reason).toContain("classAnalyses missing for blocker/major subjects: SC-01/SC-02");
    expect(result.criticLogs).toHaveLength(2);
    await Promise.all(result.criticLogs!.map((path) => expect(readFile(path, "utf8")).resolves.toBe(output)));
  });

  it("passes only with exact, source-grounded coverage for every criterion", async () => {
    const root = await fixture();
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: `\`\`\`json\n${JSON.stringify({ criterionAssessments: [assessment("SC-01"), assessment("SC-02")], findings: [], classAnalyses: [], requirementsChangeRequested: false, criteriaPatches: [] })}\n\`\`\`` }),
    });
    expect(result.result).toBe("PASSED");
    expect(result.criterionAssessments).toHaveLength(2);
  });

  it("requires and returns a causal assessment for a declared mode", async () => {
    const root = await fixture();
    const manifestPath = join(root, "docs", "programs", "alpha-manifest.json");
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as { program: Record<string, unknown> };
    value.program.executionMode = "atomic";
    value.program.executionModeReason = "one cohesive working set";
    await writeFile(manifestPath, JSON.stringify(value), "utf8");
    let prompt = "";
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async (invocation) => {
        prompt = invocation.prompt;
        return { exitCode: 0, output: `\`\`\`json\n${JSON.stringify({ criterionAssessments: [assessment("SC-01"), assessment("SC-02")], modeAssessment: { mode: "atomic", status: "appropriate", reason: "the feature is one cohesive green checkpoint", evidence: ["one workstream owns the complete change"] }, findings: [], classAnalyses: [], requirementsChangeRequested: false, criteriaPatches: [] })}\n\`\`\`` };
      },
    });
    expect(result.result).toBe("PASSED");
    expect(result.modeAssessment?.mode).toBe("atomic");
    expect(prompt).toContain("token estimates near a threshold are advisory");
  });

  it("sends an inappropriate selected mode back to replanning", async () => {
    const root = await fixture();
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      executionMode: "atomic",
      agentRunner: async () => ({ exitCode: 0, output: `\`\`\`json\n${JSON.stringify({ criterionAssessments: [assessment("SC-01"), assessment("SC-02")], modeAssessment: { mode: "atomic", status: "inappropriate", reason: "a destructive contract migration requires staged checkpoints", evidence: ["expand, two consumer migrations, then delete"] }, findings: [], classAnalyses: [], requirementsChangeRequested: false, criteriaPatches: [] })}\n\`\`\`` }),
    });
    expect(result.result).toBe("REQUIRES_REPLAN");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ subject: "execution mode", requiresReplan: true })]));
  });

  it("fails closed when the critic omits a success criterion", async () => {
    const root = await fixture();
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: `\`\`\`json\n${JSON.stringify({ criterionAssessments: [assessment("SC-01")], findings: [], classAnalyses: [] })}\n\`\`\`` }),
    });
    expect(result.result).toBe("ABORTED");
    expect(result.reason).toContain("missing: SC-02");
  });

  it("writes class-wide closure obligations before authoring", async () => {
    const root = await fixture();
    const conflict = { ...assessment("SC-01"), status: "conflict", reason: "command families have incompatible signatures" };
    const result = await auditPlan({
      cwd: root,
      programId: "alpha",
      agentRunner: async () => ({ exitCode: 0, output: `\`\`\`json\n${JSON.stringify({
        criterionAssessments: [conflict, assessment("SC-02")],
        findings: [{ severity: "blocker", category: "acceptance-criteria", subject: "SC-01", message: "One blanket rule spans incompatible command shapes.", evidence: [{ kind: "concern", named: "signature family mismatch" }], requiresReplan: true }],
        classAnalyses: [{ subject: "SC-01", scope: "systemic", rootCause: "conceptual command family ignores actual signatures", affectedSubjects: ["audit", "pack"], checkedSubjects: ["audit", "bind", "pack", "approve"], completenessBasis: "all commands named by SC-01" }],
        requirementsChangeRequested: false,
        criteriaPatches: [],
      })}\n\`\`\`` }),
    });
    expect(result.result).toBe("REQUIRES_REPLAN");
    const report = JSON.parse(await readFile(result.replanReport!, "utf8")) as { schemaVersion: number; inputHash: string; classAnalyses: unknown[]; planningInstruction: string };
    expect(report.schemaVersion).toBe(3);
    expect(report.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.classAnalyses).toHaveLength(1);
    expect(report.planningInstruction).toContain("root-cause class");
  });
});
