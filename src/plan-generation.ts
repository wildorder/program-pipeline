import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const PLAN_GENERATION_MARKER = "program-pipeline:plan-generation";
export const LEGACY_PLAN_GENERATION = "legacy";

export interface PlanManifestEnvelope {
  program?: { planGeneration?: unknown };
}

export async function readPlanGeneration(manifestPath: string): Promise<string> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as PlanManifestEnvelope;
  const generation = raw.program?.planGeneration;
  return typeof generation === "string" && generation.length > 0
    ? generation
    : LEGACY_PLAN_GENERATION;
}

export function specGeneration(content: string): string | undefined {
  return content.match(
    new RegExp(`<!--\\s*${PLAN_GENERATION_MARKER}=([^\\s]+)\\s*-->`, "u"),
  )?.[1];
}

export function stampSpecGeneration(content: string, generation: string): string {
  const marker = `<!-- ${PLAN_GENERATION_MARKER}=${generation} -->`;
  const withoutMarker = content.replace(
    new RegExp(`^<!--\\s*${PLAN_GENERATION_MARKER}=[^\\n]+-->\\r?\\n?`, "mu"),
    "",
  );
  return `${marker}\n${withoutMarker.replace(/^\uFEFF/u, "")}`;
}

/** Atomically replace a text artifact, leaving the previous file intact on failure. */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, "utf8");
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Stable fallback for plans created before generation metadata existed. */
export function legacyGenerationFingerprint(manifest: string, program: string): string {
  return `legacy-${createHash("sha256").update(manifest).update("\n").update(program).digest("hex").slice(0, 16)}`;
}
