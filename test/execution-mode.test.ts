import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseExecutionMode,
  readProgramExecutionMode,
} from "../src/execution-mode.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function manifest(program: Record<string, unknown>, workstreams = [{}]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-mode-"));
  roots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await writeFile(join(root, "docs", "programs", "alpha-manifest.json"), JSON.stringify({ program, workstreams }), "utf8");
  return root;
}

describe("execution mode", () => {
  it("parses modes and rejects unknown values", () => {
    expect(parseExecutionMode(" ATOMIC ")).toBe("atomic");
    expect(parseExecutionMode("orchestrated")).toBe("orchestrated");
    expect(() => parseExecutionMode("light")).toThrow("Unknown execution mode");
  });

  it("preserves orchestrated behavior for legacy manifests", async () => {
    const root = await manifest({ id: "alpha" });
    await expect(readProgramExecutionMode(root, "alpha")).resolves.toMatchObject({
      mode: "orchestrated",
      declared: false,
      workstreamCount: 1,
    });
  });

  it("reads a planner-selected atomic mode and its reason", async () => {
    const root = await manifest({ id: "alpha", executionMode: "atomic", executionModeReason: "one cohesive working set" });
    await expect(readProgramExecutionMode(root, "alpha")).resolves.toEqual({
      mode: "atomic",
      declared: true,
      reason: "one cohesive working set",
      workstreamCount: 1,
    });
  });
});
