import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const EXECUTION_MODES = ["atomic", "orchestrated"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface ProgramExecutionMode {
  /** Effective mode. Legacy manifests deliberately retain the old workflow. */
  mode: ExecutionMode;
  declared: boolean;
  reason?: string;
  workstreamCount: number;
}

export function parseExecutionMode(value: string): ExecutionMode {
  const mode = value.trim().toLowerCase();
  if (!(EXECUTION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unknown execution mode "${value}". Expected: ${EXECUTION_MODES.join(", ")}.`,
    );
  }
  return mode as ExecutionMode;
}

/** Read only the routing fields; deterministic validation owns the full schema. */
export async function readProgramExecutionMode(
  rootInput: string,
  programId: string,
): Promise<ProgramExecutionMode> {
  const root = resolve(rootInput);
  const path = join(root, "docs", "programs", `${programId}-manifest.json`);
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Manifest is not an object: ${path}`);
  }
  const record = raw as Record<string, unknown>;
  const program = typeof record.program === "object" && record.program !== null
    ? record.program as Record<string, unknown>
    : {};
  const declared = typeof program.executionMode === "string";
  const mode = declared
    ? parseExecutionMode(program.executionMode as string)
    : "orchestrated";
  return {
    mode,
    declared,
    ...(typeof program.executionModeReason === "string"
      ? { reason: program.executionModeReason }
      : {}),
    workstreamCount: Array.isArray(record.workstreams) ? record.workstreams.length : 0,
  };
}
