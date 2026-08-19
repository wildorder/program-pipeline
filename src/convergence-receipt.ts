import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PipelineConfig } from "./pipeline-config.js";
import { atomicWriteText } from "./plan-generation.js";

export const CONVERGENCE_RECEIPT_VERSION = 1;

export interface ConvergenceReceipt {
  schemaVersion: typeof CONVERGENCE_RECEIPT_VERSION;
  programId: string;
  inputHash: string;
  validatedAt: string;
  /** Finding IDs explicitly accepted after the semantic round cap. */
  waivedFindings?: string[];
}

export interface ConvergenceReceiptStatus {
  valid: boolean;
  path: string;
  expectedHash: string;
  receipt?: ConvergenceReceipt;
  reason?: "missing" | "unreadable" | "stale";
}

export function convergenceReceiptPath(root: string, programId: string): string {
  return join(resolve(root), "docs", "programs", `${programId}-convergence.json`);
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function withoutMutableManifestState(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const manifest = raw as Record<string, unknown>;
  const program =
    typeof manifest.program === "object" &&
    manifest.program !== null &&
    !Array.isArray(manifest.program)
      ? Object.fromEntries(
          Object.entries(manifest.program).filter(([key]) => key !== "status"),
        )
      : manifest.program;
  const workstreams = Array.isArray(manifest.workstreams)
    ? manifest.workstreams.map((workstream) =>
        typeof workstream === "object" && workstream !== null
          ? Object.fromEntries(
              Object.entries(workstream).filter(([key]) => key !== "status"),
            )
          : workstream,
      )
    : manifest.workstreams;
  return Object.fromEntries(
    Object.entries({ ...manifest, program, workstreams }).filter(
      ([key]) => key !== "criteriaApproval",
    ),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash every semantic input used by convergence, excluding mutable status. */
export async function convergenceInputHash(
  rootInput: string,
  programId: string,
  config: PipelineConfig,
): Promise<string> {
  const root = resolve(rootInput);
  const manifestPath = join(
    root,
    "docs",
    "programs",
    `${programId}-manifest.json`,
  );
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    workstreams?: Array<{ id?: string; taskFile?: string }>;
  };
  const entries: Array<[string, string]> = [
    ["receipt-contract", String(CONVERGENCE_RECEIPT_VERSION)],
    ["manifest", canonical(withoutMutableManifestState(manifest))],
    [
      "semantic-config",
      canonical({
        visionPath: config.visionPath,
        contextDocs: config.contextDocs,
        validate: config.validate,
        executionProfile: config.build.executionProfile,
      }),
    ],
  ];

  for (const relativePath of [
    `docs/programs/${programId}-program.md`,
    config.visionPath,
    "AGENTS.md",
    ...config.contextDocs,
  ]) {
    entries.push([
      relativePath,
      (await optionalText(resolve(root, relativePath))) ?? "<missing>",
    ]);
  }
  for (const workstream of manifest.workstreams ?? []) {
    if (typeof workstream.taskFile !== "string") continue;
    entries.push([
      `spec:${workstream.id ?? "unknown"}:${workstream.taskFile}`,
      await readFile(resolve(root, workstream.taskFile), "utf8"),
    ]);
  }

  return createHash("sha256").update(canonical(entries)).digest("hex");
}

export async function inspectConvergenceReceipt(
  root: string,
  programId: string,
  config: PipelineConfig,
): Promise<ConvergenceReceiptStatus> {
  const path = convergenceReceiptPath(root, programId);
  const expectedHash = await convergenceInputHash(root, programId, config);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { valid: false, path, expectedHash, reason: "missing" };
  }
  let receipt: ConvergenceReceipt;
  try {
    receipt = JSON.parse(raw) as ConvergenceReceipt;
  } catch {
    return { valid: false, path, expectedHash, reason: "unreadable" };
  }
  if (
    receipt.schemaVersion !== CONVERGENCE_RECEIPT_VERSION ||
    receipt.programId !== programId ||
    receipt.inputHash !== expectedHash
  ) {
    return {
      valid: false,
      path,
      expectedHash,
      receipt,
      reason: "stale",
    };
  }
  return { valid: true, path, expectedHash, receipt };
}

export async function writeConvergenceReceipt(
  root: string,
  programId: string,
  config: PipelineConfig,
  now: () => Date = () => new Date(),
  waivedFindings: string[] = [],
): Promise<ConvergenceReceipt> {
  const status = await inspectConvergenceReceipt(root, programId, config);
  if (status.valid && status.receipt) return status.receipt;
  const receipt: ConvergenceReceipt = {
    schemaVersion: CONVERGENCE_RECEIPT_VERSION,
    programId,
    inputHash: status.expectedHash,
    validatedAt: now().toISOString(),
    ...(waivedFindings.length === 0 ? {} : { waivedFindings }),
  };
  await atomicWriteText(status.path, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
