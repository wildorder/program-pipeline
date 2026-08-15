export interface GraphNode {
  id: string;
  dependencies: string[];
}

/**
 * Dependency-first order that preserves input order whenever multiple nodes
 * are ready. Dependencies that do not exist in the graph are ignored here;
 * validation reports them separately as blockers.
 */
export function stableTopologicalOrder<T extends GraphNode>(nodes: T[]): T[] {
  const known = new Set(nodes.map(({ id }) => id));
  const done = new Set<string>();
  const remaining = [...nodes];
  const ordered: T[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((node) =>
      node.dependencies.every(
        (dependency) => done.has(dependency) || !known.has(dependency),
      ),
    );
    if (index < 0) {
      const blocked = remaining.map(({ id }) => id).join(", ");
      throw new Error(
        `Cannot resolve dependency order; check for cycles among: ${blocked}`,
      );
    }
    const next = remaining[index] as T;
    remaining.splice(index, 1);
    ordered.push(next);
    done.add(next.id);
  }

  return ordered;
}

/**
 * The same dependency-first ordering as {@link stableTopologicalOrder}, but
 * grouped into levels: every node in a level has all of its known
 * dependencies satisfied by an earlier level, so a whole level can be
 * processed concurrently.
 *
 * Authoring uses this instead of the flat order because a flat fan-out
 * authors dependent workstreams in isolation from each other, and two
 * specs written that way disagree about the interface between them. Walking
 * levels lets each author read the finished specs of what it depends on,
 * while independent workstreams still run at the same time — only genuine
 * dependency chains serialize.
 *
 * Input order is preserved within each level, matching the stable ordering's
 * behavior. Dependencies outside the graph are ignored here; validation
 * reports them separately as blockers.
 */
export function topologicalLevels<T extends GraphNode>(nodes: T[]): T[][] {
  const known = new Set(nodes.map(({ id }) => id));
  const done = new Set<string>();
  let remaining = [...nodes];
  const levels: T[][] = [];

  while (remaining.length > 0) {
    // Computed against `done` as it stood before this level, so a node can
    // never land in the same level as something it depends on.
    const ready = remaining.filter((node) =>
      node.dependencies.every(
        (dependency) => done.has(dependency) || !known.has(dependency),
      ),
    );
    if (ready.length === 0) {
      const blocked = remaining.map(({ id }) => id).join(", ");
      throw new Error(
        `Cannot resolve dependency order; check for cycles among: ${blocked}`,
      );
    }
    levels.push(ready);
    const placed = new Set(ready.map(({ id }) => id));
    for (const id of placed) done.add(id);
    remaining = remaining.filter(({ id }) => !placed.has(id));
  }

  return levels;
}

export function findCycles(nodes: GraphNode[]): string[][] {
  const graph = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];

  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      cycles.push([...path.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of graph.keys()) visit(id, []);
  return cycles;
}
