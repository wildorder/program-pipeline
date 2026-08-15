import { describe, expect, it } from "vitest";
import { findCycles, topologicalLevels } from "../src/graph.js";

const node = (id: string, ...dependencies: string[]) => ({ id, dependencies });

const idsOf = (levels: Array<Array<{ id: string }>>): string[][] =>
  levels.map((level) => level.map(({ id }) => id));

describe("topologicalLevels", () => {
  it("groups independent nodes into one level", () => {
    const levels = topologicalLevels([
      node("WS-01"),
      node("WS-02"),
      node("WS-03"),
    ]);
    expect(idsOf(levels)).toEqual([["WS-01", "WS-02", "WS-03"]]);
  });

  it("puts a dependent node in a later level than its dependency", () => {
    const levels = topologicalLevels([
      node("WS-01"),
      node("WS-02", "WS-01"),
      node("WS-03", "WS-02"),
    ]);
    expect(idsOf(levels)).toEqual([["WS-01"], ["WS-02"], ["WS-03"]]);
  });

  it("keeps siblings together while chains serialize", () => {
    // WS-02 and WS-03 both depend only on WS-01, so they author in parallel;
    // WS-04 waits for both.
    const levels = topologicalLevels([
      node("WS-01"),
      node("WS-02", "WS-01"),
      node("WS-03", "WS-01"),
      node("WS-04", "WS-02", "WS-03"),
    ]);
    expect(idsOf(levels)).toEqual([
      ["WS-01"],
      ["WS-02", "WS-03"],
      ["WS-04"],
    ]);
  });

  it("never places a node in the same level as its dependency", () => {
    // Declaration order puts the dependent first, which a naive single-pass
    // sweep would collapse into one level.
    const levels = topologicalLevels([node("WS-02", "WS-01"), node("WS-01")]);
    expect(idsOf(levels)).toEqual([["WS-01"], ["WS-02"]]);
  });

  it("preserves input order within a level", () => {
    const levels = topologicalLevels([
      node("WS-03"),
      node("WS-01"),
      node("WS-02"),
    ]);
    expect(idsOf(levels)).toEqual([["WS-03", "WS-01", "WS-02"]]);
  });

  it("ignores dependencies that are not in the graph", () => {
    // Validation reports these separately as blockers; ordering must not
    // deadlock on them.
    const levels = topologicalLevels([node("WS-01", "WS-99"), node("WS-02")]);
    expect(idsOf(levels)).toEqual([["WS-01", "WS-02"]]);
  });

  it("throws on a cycle rather than dropping nodes", () => {
    expect(() =>
      topologicalLevels([node("WS-01", "WS-02"), node("WS-02", "WS-01")]),
    ).toThrow(/cycles among: WS-01, WS-02/u);
  });

  it("returns no levels for an empty graph", () => {
    expect(topologicalLevels([])).toEqual([]);
  });

  it("flattens to a valid dependency-first order", () => {
    // Deliberately not asserted equal to stableTopologicalOrder: that one
    // takes a single ready node and re-scans, while this takes every ready
    // node at once, so an independent node later in the input can land ahead
    // of one that only becomes ready afterward. Both are valid topological
    // orders; only the invariant below is guaranteed of each.
    const nodes = [
      node("WS-04", "WS-02", "WS-03"),
      node("WS-01"),
      node("WS-03", "WS-01"),
      node("WS-02", "WS-01"),
    ];
    const flat = topologicalLevels(nodes)
      .flat()
      .map(({ id }) => id);

    expect(flat).toHaveLength(nodes.length);
    for (const { id, dependencies } of nodes) {
      for (const dependency of dependencies) {
        expect(flat.indexOf(dependency)).toBeLessThan(flat.indexOf(id));
      }
    }
  });

  it("agrees with findCycles about which graphs are resolvable", () => {
    const cyclic = [node("WS-01", "WS-02"), node("WS-02", "WS-01")];
    expect(findCycles(cyclic).length).toBeGreaterThan(0);
    expect(() => topologicalLevels(cyclic)).toThrow();
  });
});
