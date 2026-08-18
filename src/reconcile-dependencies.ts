import { readFile } from "node:fs/promises";
import { atomicWriteText } from "./plan-generation.js";
import { findCycles } from "./graph.js";

/**
 * Dependency edges discovered during authoring are reconciled into the
 * manifest, not raised as findings.
 *
 * A finding is a problem someone must resolve. A discovered edge is not a
 * problem — if a spec consumes another workstream's output then the edge
 * exists, and the manifest is simply out of date. Correcting it is
 * transcription, and routing transcription through a human gate is what made
 * every validation run stall on "WS-07 depends on WS-03, go fix the
 * manifest".
 *
 * Exactly two outcomes still belong to a human, and neither is about an edge:
 *
 * - **A cycle.** Two workstreams that depend on each other are not badly
 *   recorded, they are badly decomposed — they are one workstream, or the
 *   split is in the wrong place. No manifest edit fixes that.
 * - **An unmet requirement.** Work the program needs and no workstream
 *   provides is missing scope, which is a planning decision.
 *
 * Everything else merges and is logged.
 */

export interface DeclaredEdges {
  workstreamId: string;
  dependencies: string[];
  needs: string[];
  unmet: string[];
}

export interface DependencyEdge {
  workstreamId: string;
  dependsOn: string;
}

export interface UnmetRequirement {
  workstreamId: string;
  requirement: string;
}

export interface ReconcileInput {
  workstreams: Array<{ id: string; dependencies: string[] }>;
  declarations: DeclaredEdges[];
}

export interface ReconcileResult {
  /** Merged dependency lists, keyed by workstream id. */
  dependencies: Map<string, string[]>;
  /** Edges that were missing from the manifest and have now been merged. */
  added: DependencyEdge[];
  /** Declared edges naming a workstream the manifest does not contain. */
  unknown: DependencyEdge[];
  /** Cycles in the merged graph; empty when the merge stays acyclic. */
  cycles: string[][];
  /** Workstreams that asked to be re-authored with a dependency's spec. */
  needs: Array<{ workstreamId: string; dependsOn: string[] }>;
  unmet: UnmetRequirement[];
}

export function reconcileDependencies(input: ReconcileInput): ReconcileResult {
  const known = new Set(input.workstreams.map(({ id }) => id));
  const merged = new Map(
    input.workstreams.map(({ id, dependencies }) => [id, [...dependencies]]),
  );
  const added: DependencyEdge[] = [];
  const unknown: DependencyEdge[] = [];
  const needs: Array<{ workstreamId: string; dependsOn: string[] }> = [];
  const unmet: UnmetRequirement[] = [];

  for (const declaration of input.declarations) {
    const current = merged.get(declaration.workstreamId);
    if (!current) continue;

    // `needs` is a dependency whose spec the author could not see, so it is
    // an edge every bit as much as anything in `dependencies`.
    const declared = [
      ...new Set([...declaration.dependencies, ...declaration.needs]),
    ];
    for (const dependsOn of declared) {
      if (dependsOn === declaration.workstreamId) continue;
      const edge = { workstreamId: declaration.workstreamId, dependsOn };
      if (!known.has(dependsOn)) {
        unknown.push(edge);
        continue;
      }
      if (current.includes(dependsOn)) continue;
      current.push(dependsOn);
      added.push(edge);
    }

    const wanted = declaration.needs.filter(
      (id) => known.has(id) && id !== declaration.workstreamId,
    );
    if (wanted.length > 0) {
      needs.push({ workstreamId: declaration.workstreamId, dependsOn: wanted });
    }
    for (const requirement of declaration.unmet) {
      unmet.push({ workstreamId: declaration.workstreamId, requirement });
    }
  }

  const cycles = findCycles(
    [...merged].map(([id, dependencies]) => ({ id, dependencies })),
  );

  return { dependencies: merged, added, unknown, cycles, needs, unmet };
}

/**
 * Persist merged dependency lists to the manifest, preserving every other
 * field and the file's key order. Only workstreams present in `dependencies`
 * are touched.
 */
export async function writeMergedDependencies(
  manifestPath: string,
  dependencies: Map<string, string[]>,
): Promise<void> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    workstreams?: Array<{ id: string; dependencies: string[] }>;
  };
  for (const workstream of raw.workstreams ?? []) {
    const merged = dependencies.get(workstream.id);
    if (merged) workstream.dependencies = merged;
  }
  await atomicWriteText(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Human-readable edge list for progress output and failure reasons. */
export function describeEdges(edges: DependencyEdge[]): string {
  return edges
    .map(({ workstreamId, dependsOn }) => `${workstreamId} -> ${dependsOn}`)
    .join(", ");
}
