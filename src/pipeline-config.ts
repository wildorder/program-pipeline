import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PIPELINE_CONFIG_FILE = "pipeline.config.json";

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
  verify: z.record(z.string(), z.string().min(1)).default({}),
  build: z
    .object({
      maxRecoveryAttempts: z.number().int().min(0).default(1),
      logDir: z.string().min(1).default("build-logs"),
    })
    .default({ maxRecoveryAttempts: 1, logDir: "build-logs" }),
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
