import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeEdges,
  reconcileDependencies,
  writeMergedDependencies,
  type DeclaredEdges,
} from "../src/reconcile-dependencies.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const declares = (
  workstreamId: string,
  edges: Partial<Omit<DeclaredEdges, "workstreamId">> = {},
): DeclaredEdges => ({
  workstreamId,
  dependencies: [],
  needs: [],
  unmet: [],
  ...edges,
});

const graph = (entries: Array<[string, string[]]>) =>
  entries.map(([id, dependencies]) => ({ id, dependencies }));

describe("reconcileDependencies", () => {
  it("merges an edge the manifest never declared", () => {
    const result = reconcileDependencies({
      workstreams: graph([
        ["WS-01", []],
        ["WS-07", []],
      ]),
      declarations: [declares("WS-07", { dependencies: ["WS-01"] })],
    });

    expect(result.dependencies.get("WS-07")).toEqual(["WS-01"]);
    expect(result.added).toEqual([
      { workstreamId: "WS-07", dependsOn: "WS-01" },
    ]);
    expect(result.cycles).toEqual([]);
  });

  it("leaves an edge the manifest already had alone", () => {
    const result = reconcileDependencies({
      workstreams: graph([
        ["WS-01", []],
        ["WS-07", ["WS-01"]],
      ]),
      declarations: [declares("WS-07", { dependencies: ["WS-01"] })],
    });

    expect(result.dependencies.get("WS-07")).toEqual(["WS-01"]);
    expect(result.added).toEqual([]);
  });

  it("treats a needed spec as a dependency edge", () => {
    // If an author could not write the spec without seeing WS-01, then this
    // workstream depends on WS-01 whatever the manifest said.
    const result = reconcileDependencies({
      workstreams: graph([
        ["WS-01", []],
        ["WS-07", []],
      ]),
      declarations: [declares("WS-07", { needs: ["WS-01"] })],
    });

    expect(result.dependencies.get("WS-07")).toEqual(["WS-01"]);
    expect(result.needs).toEqual([
      { workstreamId: "WS-07", dependsOn: ["WS-01"] },
    ]);
  });

  it("ignores a workstream declaring itself", () => {
    const result = reconcileDependencies({
      workstreams: graph([["WS-01", []]]),
      declarations: [
        declares("WS-01", { dependencies: ["WS-01"], needs: ["WS-01"] }),
      ],
    });

    expect(result.dependencies.get("WS-01")).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.needs).toEqual([]);
  });

  it("reports an edge naming an unknown workstream without merging it", () => {
    const result = reconcileDependencies({
      workstreams: graph([["WS-01", []]]),
      declarations: [declares("WS-01", { dependencies: ["WS-99"] })],
    });

    expect(result.dependencies.get("WS-01")).toEqual([]);
    expect(result.unknown).toEqual([
      { workstreamId: "WS-01", dependsOn: "WS-99" },
    ]);
    expect(result.added).toEqual([]);
  });

  it("detects a cycle the merge would create", () => {
    const result = reconcileDependencies({
      workstreams: graph([
        ["WS-01", []],
        ["WS-02", ["WS-01"]],
      ]),
      declarations: [declares("WS-01", { dependencies: ["WS-02"] })],
    });

    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles.flat()).toContain("WS-01");
    expect(result.cycles.flat()).toContain("WS-02");
  });

  it("stays acyclic when the new edge is merely undeclared", () => {
    const result = reconcileDependencies({
      workstreams: graph([
        ["WS-01", []],
        ["WS-02", ["WS-01"]],
        ["WS-03", []],
      ]),
      declarations: [declares("WS-03", { dependencies: ["WS-02"] })],
    });

    expect(result.cycles).toEqual([]);
    expect(result.added).toEqual([
      { workstreamId: "WS-03", dependsOn: "WS-02" },
    ]);
  });

  it("collects unmet requirements against the workstream that raised them", () => {
    const result = reconcileDependencies({
      workstreams: graph([["WS-01", []]]),
      declarations: [declares("WS-01", { unmet: ["token rotation"] })],
    });

    expect(result.unmet).toEqual([
      { workstreamId: "WS-01", requirement: "token rotation" },
    ]);
  });

  it("ignores a declaration from a workstream not in the manifest", () => {
    const result = reconcileDependencies({
      workstreams: graph([["WS-01", []]]),
      declarations: [declares("WS-42", { dependencies: ["WS-01"] })],
    });

    expect(result.added).toEqual([]);
    expect(result.dependencies.has("WS-42")).toBe(false);
  });
});

describe("writeMergedDependencies", () => {
  it("rewrites dependencies and preserves every other field", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-reconcile-"));
    temporaryRoots.push(root);
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          program: { id: "alpha", name: "Alpha", status: "planning" },
          successCriteria: [{ id: "SC-01", description: "Works." }],
          workstreams: [
            {
              id: "WS-01",
              name: "Core",
              taskFile: "tasks/alpha/ws-01.md",
              status: "not_started",
              dependencies: [],
              scope: { summary: "Core things." },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeMergedDependencies(
      manifestPath,
      new Map([["WS-01", ["WS-02"]]]),
    );

    const written = JSON.parse(await readFile(manifestPath, "utf8")) as {
      program: { name: string };
      workstreams: Array<{
        dependencies: string[];
        scope: { summary: string };
        status: string;
      }>;
    };
    expect(written.workstreams[0]?.dependencies).toEqual(["WS-02"]);
    expect(written.workstreams[0]?.scope.summary).toBe("Core things.");
    expect(written.workstreams[0]?.status).toBe("not_started");
    expect(written.program.name).toBe("Alpha");
  });

  it("leaves workstreams absent from the map untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-reconcile-"));
    temporaryRoots.push(root);
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        workstreams: [
          { id: "WS-01", dependencies: ["WS-00"] },
          { id: "WS-02", dependencies: [] },
        ],
      })}\n`,
      "utf8",
    );

    await writeMergedDependencies(manifestPath, new Map([["WS-02", ["WS-01"]]]));

    const written = JSON.parse(await readFile(manifestPath, "utf8")) as {
      workstreams: Array<{ id: string; dependencies: string[] }>;
    };
    expect(written.workstreams[0]?.dependencies).toEqual(["WS-00"]);
    expect(written.workstreams[1]?.dependencies).toEqual(["WS-01"]);
  });
});

describe("describeEdges", () => {
  it("renders edges as arrows", () => {
    expect(
      describeEdges([
        { workstreamId: "WS-07", dependsOn: "WS-03" },
        { workstreamId: "WS-08", dependsOn: "WS-01" },
      ]),
    ).toBe("WS-07 -> WS-03, WS-08 -> WS-01");
  });
});
