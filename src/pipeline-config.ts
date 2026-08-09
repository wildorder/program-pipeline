import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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
  agent: agentSchema.optional(),
  validatorAgent: agentSchema.optional(),
  models: z.record(z.string(), z.string().min(1)).default({}),
  verify: z.record(z.string(), z.string().min(1)).default({}),
  contextDocs: z.array(z.string().min(1)).default([]),
  build: z
    .object({
      maxRecoveryAttempts: z.number().int().min(0).default(1),
      verifyRetries: z.number().int().min(0).default(1),
      logDir: z.string().min(1).default("build-logs"),
      commit: z.boolean().default(true),
      /** Critique the workstream diff's tests before the runner commits. */
      critiqueTests: z.boolean().default(false),
    })
    .default({
      maxRecoveryAttempts: 1,
      verifyRetries: 1,
      logDir: "build-logs",
      commit: true,
      critiqueTests: false,
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
      `${PIPELINE_CONFIG_FILE} not found in ${root}; run program-pipeline init first.`,
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
