import { describe, expect, it } from "vitest";
import {
  assessRepositoryExecutionFit,
  declaredTouchedFiles,
  DEFAULT_EXECUTION_FIT_POLICY,
  estimateExecutionFit,
} from "../src/execution-fit.js";
import { pipelineConfigSchema } from "../src/pipeline-config.js";

const baseConfig = {
  schemaVersion: 1 as const,
  pipelineVersion: "1.2.3",
  visionPath: "docs/vision.md",
  requireApprovalBeforeBuild: false,
};

describe("estimateExecutionFit", () => {
  it("uses a tolerant 250k-class default profile", () => {
    expect(DEFAULT_EXECUTION_FIT_POLICY).toEqual({
      contextWindowTokens: 250_000,
      targetWorkingSetTokens: 100_000,
      cautionWorkingSetTokens: 140_000,
      hardWorkingSetTokens: 190_000,
      toleranceTokens: 10_000,
      bytesPerToken: 4,
      byteEstimateUncertainty: 0.25,
      missingNewFileTokens: 4_000,
    });
  });

  it("does not penalize a 5k target overage", () => {
    const result = estimateExecutionFit({
      tokenComponents: { prompt: 60_000, source: 45_000 },
    });

    expect(result).toMatchObject({
      classification: "normal",
      workingSetTokens: 105_000,
      hardFailure: false,
      approvalRequired: false,
    });
  });

  it.each([
    [125_000, "caution"],
    [170_000, "oversized"],
    [250_001, "physically-impossible"],
  ] as const)("classifies %i exact tokens as %s", (tokens, classification) => {
    expect(
      estimateExecutionFit({ tokenComponents: { all: tokens } }).classification,
    ).toBe(classification);
  });

  it("converts the total byte count deterministically regardless of component split", () => {
    const together = estimateExecutionFit({ byteComponents: { files: 13 } });
    const split = estimateExecutionFit({
      byteComponents: { spec: 5, source: 8 },
    });

    expect(together.estimatedTokensFromBytes).toBe(4);
    expect(split.estimatedTokensFromBytes).toBe(4);
    expect(split.workingSetTokens).toBe(together.workingSetTokens);
  });

  it("keeps an uncertain over-capacity estimate soft unless its lower bound cannot fit", () => {
    const uncertain = estimateExecutionFit({
      // 1,080,000 / 4 = 270,000, with a 25% uncertainty band.
      byteComponents: { repository: 1_080_000 },
    });
    expect(uncertain).toMatchObject({
      workingSetTokens: 270_000,
      uncertaintyTokens: 67_500,
      lowerBoundTokens: 202_500,
      upperBoundTokens: 337_500,
      classification: "oversized",
      hardFailure: false,
      approvalRequired: true,
    });

    const impossible = estimateExecutionFit({
      // 340,004 estimated tokens, whose tolerant lower bound is still >250k.
      byteComponents: { repository: 1_360_016 },
    });
    expect(impossible.classification).toBe("physically-impossible");
    expect(impossible.lowerBoundTokens).toBeGreaterThan(250_000);
    expect(impossible.hardFailure).toBe(true);
  });

  it("records approval and a non-empty justification for oversized work", () => {
    const pending = estimateExecutionFit({
      tokenComponents: { all: 170_000 },
      approval: { approved: true, justification: "   " },
    });
    expect(pending.approval).toEqual({ approved: true, satisfied: false });

    const approved = estimateExecutionFit({
      tokenComponents: { all: 170_000 },
      approval: {
        approved: true,
        justification: "The workstream cannot be split without duplicating state.",
      },
    });
    expect(approved.approval).toEqual({
      approved: true,
      justification: "The workstream cannot be split without duplicating state.",
      satisfied: true,
    });
  });

  it("does not make physical impossibility overridable by approval", () => {
    const result = estimateExecutionFit({
      tokenComponents: { all: 260_000 },
      approval: { approved: true, justification: "Try anyway." },
    });

    expect(result).toMatchObject({
      classification: "physically-impossible",
      hardFailure: true,
      approvalRequired: false,
    });
    expect(result.approval).toBeUndefined();
  });

  it("rejects invalid components and invalid direct-call policies", () => {
    expect(() =>
      estimateExecutionFit({ tokenComponents: { prompt: -1 } }),
    ).toThrow("non-negative safe integer");
    expect(() =>
      estimateExecutionFit(
        {},
        {
          ...DEFAULT_EXECUTION_FIT_POLICY,
          hardWorkingSetTokens: 90_000,
        },
      ),
    ).toThrow("target < caution < hard <= context window");
  });
});

describe("repository execution fit", () => {
  const specMarkdown = `# WS-01

## Files Touched
- (MODIFY) \`src/existing.ts\`
- (NEW) \`src/new.ts\`
- (MODIFY) \`src/missing.ts\`
- (NEW) \`src/new.ts\`

## Tests
- test it
`;

  it("parses unique declared files and their NEW annotation", () => {
    expect(declaredTouchedFiles(specMarkdown)).toEqual([
      { path: "src/existing.ts", isNew: false },
      { path: "src/new.ts", isNew: true },
      { path: "src/missing.ts", isNew: false },
    ]);
  });

  it("measures static, spec, and touched-file text with a missing-NEW allowance", async () => {
    const texts = new Map([
      ["AGENTS.md", "aaaa"],
      ["docs/vision.md", "vvvvvvvv"],
      ["docs/context.md", "cccccccccccc"],
      ["src/existing.ts", "eeeeeeeeeeeeeeee"],
    ]);
    const result = await assessRepositoryExecutionFit(
      {
        root: ".",
        specMarkdown,
        visionPath: "docs/vision.md",
        // The duplicate vision path must not be counted twice.
        contextDocs: ["docs/context.md", "docs/vision.md"],
        readText: async (absolutePath) => {
          const normalized = absolutePath.replaceAll("\\", "/");
          return [...texts].find(([path]) => normalized.endsWith(path))?.[1];
        },
      },
      {
        ...DEFAULT_EXECUTION_FIT_POLICY,
        byteEstimateUncertainty: 0,
        missingNewFileTokens: 20,
      },
    );

    expect(result.components).toEqual({
      staticCharacters: 24,
      specCharacters: specMarkdown.length,
      touchedFileCharacters: 16,
      missingNewFileTokens: 20,
    });
    expect(result.workingSetTokens).toBe(
      Math.ceil((24 + specMarkdown.length + 16) / 4) + 20,
    );
    expect(result.missingNewFiles).toEqual(["src/new.ts"]);
    expect(result.missingReferencedFiles).toEqual(["src/missing.ts"]);
  });

  it("can read the spec by task path and does not count that path as context", async () => {
    const reads: string[] = [];
    const result = await assessRepositoryExecutionFit({
      root: ".",
      taskPath: "tasks/alpha/ws-01.md",
      visionPath: "docs/vision.md",
      contextDocs: ["tasks/alpha/ws-01.md"],
      readText: async (absolutePath) => {
        reads.push(absolutePath);
        const normalized = absolutePath.replaceAll("\\", "/");
        if (normalized.endsWith("tasks/alpha/ws-01.md")) return specMarkdown;
        return "";
      },
    });

    expect(result.components.specCharacters).toBe(specMarkdown.length);
    expect(reads.filter((path) => path.includes("ws-01.md"))).toHaveLength(1);
  });

  it("rejects absent specs and paths outside the repository", async () => {
    await expect(
      assessRepositoryExecutionFit({
        root: ".",
        visionPath: "docs/vision.md",
      }),
    ).rejects.toThrow("requires specMarkdown or taskPath");
    await expect(
      assessRepositoryExecutionFit({
        root: ".",
        specMarkdown,
        visionPath: "../vision.md",
        readText: async () => "",
      }),
    ).rejects.toThrow("escapes the project root");
  });
});

describe("pipeline execution-fit configuration", () => {
  it("applies the complete default policy when omitted", () => {
    const config = pipelineConfigSchema.parse(baseConfig);
    expect(config.build.executionProfile).toEqual(DEFAULT_EXECUTION_FIT_POLICY);
  });

  it("fills omitted fields in a partial custom policy", () => {
    const config = pipelineConfigSchema.parse({
      ...baseConfig,
      build: {
        executionProfile: {
          contextWindowTokens: 300_000,
          hardWorkingSetTokens: 280_000,
        },
      },
    });

    expect(config.build.executionProfile).toEqual({
      ...DEFAULT_EXECUTION_FIT_POLICY,
      contextWindowTokens: 300_000,
      hardWorkingSetTokens: 280_000,
    });
  });

  it("rejects unordered bands and hard limits beyond the context window", () => {
    const unordered = pipelineConfigSchema.safeParse({
      ...baseConfig,
      build: { executionProfile: { targetWorkingSetTokens: 210_000 } },
    });
    expect(unordered.success).toBe(false);

    const beyondContext = pipelineConfigSchema.safeParse({
      ...baseConfig,
      build: { executionProfile: { contextWindowTokens: 180_000 } },
    });
    expect(beyondContext.success).toBe(false);
  });

  it("rejects invalid tolerance and uncertainty values", () => {
    expect(
      pipelineConfigSchema.safeParse({
        ...baseConfig,
        build: { executionProfile: { toleranceTokens: -1 } },
      }).success,
    ).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({
        ...baseConfig,
        build: { executionProfile: { byteEstimateUncertainty: 1 } },
      }).success,
    ).toBe(false);
  });
});
