import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Provider-neutral context-fit estimation.
 *
 * Callers supply the inputs they know exactly as tokens and the inputs they
 * only know as bytes. Keeping those components separate makes the estimate
 * deterministic while preserving the uncertainty introduced by byte-to-token
 * conversion.
 */

export const DEFAULT_EXECUTION_FIT_POLICY = {
  contextWindowTokens: 250_000,
  targetWorkingSetTokens: 100_000,
  cautionWorkingSetTokens: 140_000,
  hardWorkingSetTokens: 190_000,
  toleranceTokens: 10_000,
  bytesPerToken: 4,
  byteEstimateUncertainty: 0.25,
  missingNewFileTokens: 4_000,
} as const;

export interface ExecutionFitPolicy {
  contextWindowTokens: number;
  targetWorkingSetTokens: number;
  cautionWorkingSetTokens: number;
  hardWorkingSetTokens: number;
  /**
   * Deliberate slack around the target and caution boundaries. Estimation is
   * not precise enough for a small overage to force a different execution
   * strategy.
   */
  toleranceTokens: number;
  bytesPerToken: number;
  /** Fractional uncertainty applied only to tokens estimated from bytes. */
  byteEstimateUncertainty: number;
  /** Working-set allowance for each declared (NEW) file not on disk yet. */
  missingNewFileTokens: number;
}

export interface ExecutionFitApproval {
  approved: boolean;
  justification?: string;
}

export interface ExecutionFitInput {
  /** Components whose token counts are already known. */
  tokenComponents?: Readonly<Record<string, number>>;
  /** Components that must be converted to tokens using `bytesPerToken`. */
  byteComponents?: Readonly<Record<string, number>>;
  /** Optional human decision for an oversized, but still possible, run. */
  approval?: ExecutionFitApproval;
}

export type ExecutionFitClassification =
  | "normal"
  | "caution"
  | "oversized"
  | "physically-impossible";

export interface ExecutionFitEstimate {
  classification: ExecutionFitClassification;
  knownTokens: number;
  estimatedTokensFromBytes: number;
  workingSetTokens: number;
  uncertaintyTokens: number;
  lowerBoundTokens: number;
  upperBoundTokens: number;
  /** True only when even the tolerant lower bound exceeds physical capacity. */
  hardFailure: boolean;
  /** Oversized runs are possible, but should be an explicit human decision. */
  approvalRequired: boolean;
  approval?: {
    approved: boolean;
    justification?: string;
    satisfied: boolean;
  };
}

function sumComponents(
  components: Readonly<Record<string, number>> | undefined,
  unit: string,
): number {
  let total = 0;
  for (const [name, value] of Object.entries(components ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${unit} component '${name}' must be a non-negative safe integer`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`${unit} component total exceeds the safe integer range`);
    }
  }
  return total;
}

function assertPolicy(policy: ExecutionFitPolicy): void {
  const integerFields = [
    "contextWindowTokens",
    "targetWorkingSetTokens",
    "cautionWorkingSetTokens",
    "hardWorkingSetTokens",
    "toleranceTokens",
    "missingNewFileTokens",
  ] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
  }
  if (
    policy.targetWorkingSetTokens >= policy.cautionWorkingSetTokens ||
    policy.cautionWorkingSetTokens >= policy.hardWorkingSetTokens ||
    policy.hardWorkingSetTokens > policy.contextWindowTokens
  ) {
    throw new Error(
      "execution-fit thresholds must satisfy target < caution < hard <= context window",
    );
  }
  if (!Number.isFinite(policy.bytesPerToken) || policy.bytesPerToken <= 0) {
    throw new Error("bytesPerToken must be greater than zero");
  }
  if (
    !Number.isFinite(policy.byteEstimateUncertainty) ||
    policy.byteEstimateUncertainty < 0 ||
    policy.byteEstimateUncertainty >= 1
  ) {
    throw new Error("byteEstimateUncertainty must be at least zero and less than one");
  }
}

/** Deterministically estimate whether a supplied working set fits one run. */
export function estimateExecutionFit(
  input: ExecutionFitInput,
  policy: ExecutionFitPolicy = DEFAULT_EXECUTION_FIT_POLICY,
): ExecutionFitEstimate {
  assertPolicy(policy);
  const knownTokens = sumComponents(input.tokenComponents, "token");
  const totalBytes = sumComponents(input.byteComponents, "byte");
  const estimatedTokensFromBytes = Math.ceil(totalBytes / policy.bytesPerToken);
  const workingSetTokens = knownTokens + estimatedTokensFromBytes;
  if (!Number.isSafeInteger(workingSetTokens)) {
    throw new Error("estimated working set exceeds the safe integer range");
  }

  const uncertaintyTokens = Math.ceil(
    estimatedTokensFromBytes * policy.byteEstimateUncertainty,
  );
  const lowerBoundTokens = Math.max(knownTokens, workingSetTokens - uncertaintyTokens);
  const upperBoundTokens = workingSetTokens + uncertaintyTokens;

  let classification: ExecutionFitClassification;
  if (lowerBoundTokens > policy.contextWindowTokens) {
    classification = "physically-impossible";
  } else if (
    workingSetTokens <=
      policy.targetWorkingSetTokens + policy.toleranceTokens &&
    upperBoundTokens <= policy.hardWorkingSetTokens
  ) {
    classification = "normal";
  } else if (
    workingSetTokens <=
      policy.cautionWorkingSetTokens + policy.toleranceTokens &&
    upperBoundTokens <= policy.hardWorkingSetTokens
  ) {
    classification = "caution";
  } else {
    classification = "oversized";
  }

  const approvalRequired = classification === "oversized";
  const justification = input.approval?.justification?.trim();
  const approval = approvalRequired
    ? {
        approved: input.approval?.approved ?? false,
        ...(justification ? { justification } : {}),
        satisfied: input.approval?.approved === true && justification !== undefined && justification !== "",
      }
    : undefined;

  return {
    classification,
    knownTokens,
    estimatedTokensFromBytes,
    workingSetTokens,
    uncertaintyTokens,
    lowerBoundTokens,
    upperBoundTokens,
    hardFailure: classification === "physically-impossible",
    approvalRequired,
    ...(approval === undefined ? {} : { approval }),
  };
}

export interface DeclaredTouchedFile {
  path: string;
  isNew: boolean;
}

export type ExecutionFitTextReader = (
  absolutePath: string,
) => Promise<string | undefined>;

export interface RepositoryExecutionFitInput {
  root: string;
  /** Supply the spec directly, or omit it and provide `taskPath`. */
  specMarkdown?: string;
  taskPath?: string;
  visionPath: string;
  contextDocs?: readonly string[];
  agentsPath?: string;
  readText?: ExecutionFitTextReader;
  approval?: ExecutionFitApproval;
}

export interface RepositoryExecutionFitComponents {
  staticCharacters: number;
  specCharacters: number;
  touchedFileCharacters: number;
  missingNewFileTokens: number;
}

export interface RepositoryExecutionFitAssessment extends ExecutionFitEstimate {
  components: RepositoryExecutionFitComponents;
  touchedFiles: DeclaredTouchedFile[];
  missingNewFiles: string[];
  missingReferencedFiles: string[];
}

/** Parse file entries only from the spec's `Files Touched` section. */
export function declaredTouchedFiles(specMarkdown: string): DeclaredTouchedFile[] {
  const lines = specMarkdown.split(/\r?\n/u);
  let inSection = false;
  const files = new Map<string, DeclaredTouchedFile>();
  for (const line of lines) {
    if (/^##\s+Files Touched\s*$/iu.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/u.test(line)) break;
    if (!inSection) continue;
    const path = line.match(/`([^`]+)`/u)?.[1]?.trim();
    if (!path || files.has(path)) continue;
    files.set(path, { path, isNew: /\(\s*NEW\b[^)]*\)/iu.test(line) });
  }
  return [...files.values()];
}

const defaultTextReader: ExecutionFitTextReader = async (absolutePath) => {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
};

function repositoryPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..\\`) ||
    fromRoot.startsWith("../")
  ) {
    throw new Error(`repository fit path escapes the project root: ${path}`);
  }
  return absolute;
}

/**
 * Measure the material one workstream asks an agent to carry. Text is counted
 * by characters and converted with the configured chars-per-token ratio; a
 * missing (NEW) file receives an explicit allowance instead of counting zero.
 */
export async function assessRepositoryExecutionFit(
  input: RepositoryExecutionFitInput,
  policy: ExecutionFitPolicy = DEFAULT_EXECUTION_FIT_POLICY,
): Promise<RepositoryExecutionFitAssessment> {
  assertPolicy(policy);
  const root = resolve(input.root);
  const readText = input.readText ?? defaultTextReader;
  if (input.specMarkdown === undefined && input.taskPath === undefined) {
    throw new Error("repository execution fit requires specMarkdown or taskPath");
  }
  const taskAbsolute =
    input.taskPath === undefined ? undefined : repositoryPath(root, input.taskPath);
  const specMarkdown =
    input.specMarkdown ??
    (taskAbsolute === undefined ? undefined : await readText(taskAbsolute));
  if (specMarkdown === undefined) {
    throw new Error(`workstream spec not found: ${input.taskPath ?? "(unspecified)"}`);
  }

  const seen = new Set<string>();
  if (taskAbsolute !== undefined) seen.add(taskAbsolute);
  let staticCharacters = 0;
  const missingReferencedFiles: string[] = [];
  for (const path of [
    input.agentsPath ?? "AGENTS.md",
    input.visionPath,
    ...(input.contextDocs ?? []),
  ]) {
    const absolute = repositoryPath(root, path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = await readText(absolute);
    if (text === undefined) missingReferencedFiles.push(path);
    else staticCharacters += text.length;
  }

  const touchedFiles = declaredTouchedFiles(specMarkdown);
  const missingNewFiles: string[] = [];
  let touchedFileCharacters = 0;
  for (const file of touchedFiles) {
    const absolute = repositoryPath(root, file.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = await readText(absolute);
    if (text !== undefined) {
      touchedFileCharacters += text.length;
    } else if (file.isNew) {
      missingNewFiles.push(file.path);
    } else {
      missingReferencedFiles.push(file.path);
    }
  }

  const missingNewFileTokens =
    missingNewFiles.length * policy.missingNewFileTokens;
  const estimate = estimateExecutionFit(
    {
      byteComponents: {
        static: staticCharacters,
        spec: specMarkdown.length,
        touchedFiles: touchedFileCharacters,
      },
      tokenComponents: { missingNewFiles: missingNewFileTokens },
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    },
    policy,
  );

  return {
    ...estimate,
    components: {
      staticCharacters,
      specCharacters: specMarkdown.length,
      touchedFileCharacters,
      missingNewFileTokens,
    },
    touchedFiles,
    missingNewFiles,
    missingReferencedFiles,
  };
}
