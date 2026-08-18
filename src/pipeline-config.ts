import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_EXECUTION_FIT_POLICY } from "./execution-fit.js";

export const PIPELINE_CONFIG_FILE = "pipeline.config.json";

/**
 * Hard cap on convergence rounds. Majors are the largest and most subjective
 * finding class, so a critic can keep minting new ones indefinitely; in
 * practice the cap, not the clean-round terminator, is what usually stops the
 * loop. Each round is a full pass by two models over the program, so this
 * ceiling is a cost control as much as a correctness one.
 */
export const MAX_VALIDATE_ROUNDS = 3;

const agentSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptMode: z.enum(["stdin", "argument"]).default("stdin"),
});

const executionFitSchema = z
  .object({
    contextWindowTokens: z.number().int().positive().default(
      DEFAULT_EXECUTION_FIT_POLICY.contextWindowTokens,
    ),
    targetWorkingSetTokens: z.number().int().positive().default(
      DEFAULT_EXECUTION_FIT_POLICY.targetWorkingSetTokens,
    ),
    cautionWorkingSetTokens: z.number().int().positive().default(
      DEFAULT_EXECUTION_FIT_POLICY.cautionWorkingSetTokens,
    ),
    hardWorkingSetTokens: z.number().int().positive().default(
      DEFAULT_EXECUTION_FIT_POLICY.hardWorkingSetTokens,
    ),
    toleranceTokens: z.number().int().min(0).default(
      DEFAULT_EXECUTION_FIT_POLICY.toleranceTokens,
    ),
    bytesPerToken: z.number().positive().default(
      DEFAULT_EXECUTION_FIT_POLICY.bytesPerToken,
    ),
    byteEstimateUncertainty: z.number().min(0).lt(1).default(
      DEFAULT_EXECUTION_FIT_POLICY.byteEstimateUncertainty,
    ),
    missingNewFileTokens: z.number().int().min(0).default(
      DEFAULT_EXECUTION_FIT_POLICY.missingNewFileTokens,
    ),
  })
  .refine(
    ({
      targetWorkingSetTokens,
      cautionWorkingSetTokens,
      hardWorkingSetTokens,
      contextWindowTokens,
    }) =>
      targetWorkingSetTokens < cautionWorkingSetTokens &&
      cautionWorkingSetTokens < hardWorkingSetTokens &&
      hardWorkingSetTokens <= contextWindowTokens,
    {
      message:
        "thresholds must satisfy targetWorkingSetTokens < cautionWorkingSetTokens < hardWorkingSetTokens <= contextWindowTokens",
    },
  );

export const pipelineConfigSchema = z.object({
  schemaVersion: z.literal(1),
  pipelineVersion: z
    .string()
    .regex(
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u,
      "must be a semver version",
    ),
  visionPath: z.string().min(1),
  requireApprovalBeforeBuild: z.boolean(),
  /** Implements workstreams. A cheaper model is often the right call here. */
  agent: agentSchema.optional(),
  /**
   * Handles build recovery attempts. When absent, recovery reuses `agent`;
   * configure a different provider or model to escape capacity and context
   * failures in the primary invocation.
   */
  recoveryAgent: agentSchema.optional(),
  /**
   * Reasons about specs in the convergence loop. Distinct from `agent`:
   * implementing a spec and judging one want different models, and borrowing
   * the build agent silently put a cheap model in charge of critiquing and
   * rewriting expensively authored specs.
   */
  authorAgent: agentSchema.optional(),
  /** The independent second opinion: spec loop critic and test critique. */
  validatorAgent: agentSchema.optional(),
  models: z.record(z.string(), z.string().min(1)).default({}),
  verify: z.record(z.string(), z.string().min(1)).default({}),
  contextDocs: z.array(z.string().min(1)).default([]),
  build: z
    .object({
      maxRecoveryAttempts: z.number().int().min(0).default(1),
      verifyRetries: z.number().int().min(0).default(0),
      logDir: z.string().min(1).default("build-logs"),
      commit: z.boolean().default(true),
      /** Critique the workstream diff's tests before the runner commits. */
      critiqueTests: z.boolean().default(false),
      /**
       * Refuse to build until this program's acceptance criteria have been
       * approved. Off by default because turning it on retroactively would
       * block every existing project's next build; new projects opt in.
       */
      requireCriteriaApproval: z.boolean().default(false),
      executionProfile: executionFitSchema.default(DEFAULT_EXECUTION_FIT_POLICY),
    })
    .default({
      maxRecoveryAttempts: 1,
      verifyRetries: 0,
      logDir: "build-logs",
      commit: true,
      critiqueTests: false,
      requireCriteriaApproval: false,
      executionProfile: DEFAULT_EXECUTION_FIT_POLICY,
    }),
  author: z
    .object({
      /**
       * Agents spawned at once inside one dependency level. Authoring fans
       * out one clean agent per workstream, so an unbounded level would
       * launch as many agent CLIs as the level is wide.
       */
      concurrency: z.number().int().min(1).default(4),
      /**
       * Character budget for the full dependency specs carried in one
       * authoring brief. Past it the largest are cut to their roster entry —
       * a wide fan-in, not a deep chain, is what makes a brief large.
       */
      maxDependencySpecChars: z.number().int().min(1000).default(120_000),
      /**
       * Authoring passes before churn is called. Each pass merges the edges
       * its authors declared and re-authors whatever asked for a spec it did
       * not have. Edges only ever grow, so this terminates on its own; the
       * cap is for an agent that keeps asking for the same thing.
       */
      maxReconcilePasses: z.number().int().min(1).default(3),
    })
    .default({
      concurrency: 4,
      maxDependencySpecChars: 120_000,
      maxReconcilePasses: 3,
    }),
  validate: z
    .object({
      /**
       * Rounds of the author/critic convergence loop. 1 is a single
       * one-shot critique — the pre-loop behavior.
       */
      rounds: z.number().int().min(1).max(MAX_VALIDATE_ROUNDS).default(2),
      strict: z.boolean().default(false),
      /**
       * Rounds up to and including this number always cover the whole
       * program. Scoping earlier would use the declared dependency graph to
       * choose which workstreams to re-check — but finding *undeclared*
       * dependencies is part of the job, so an undeclared consumer would sit
       * outside the scoped set and never be examined. The graph is only
       * trustworthy enough to scope with once it has survived a full pass.
       */
      scopeDownAfterRound: z.number().int().min(2).default(2),
    })
    .default({ rounds: 2, strict: false, scopeDownAfterRound: 2 }),
});

export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;

export async function loadPipelineConfig(root: string): Promise<PipelineConfig> {
  const path = join(root, PIPELINE_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `${PIPELINE_CONFIG_FILE} not found in ${root}; run npx @wildorder/program-pipeline init --cwd "${root}" first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${PIPELINE_CONFIG_FILE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const result = pipelineConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "/"} ${issue.message}`)
      .join("; ");
    throw new Error(`${PIPELINE_CONFIG_FILE} is invalid: ${issues}`);
  }
  return result.data;
}
