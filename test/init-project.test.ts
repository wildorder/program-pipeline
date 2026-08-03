import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/init-project.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("initProject", () => {
  it("creates a complete project scaffold without overwriting authored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(join(root, ".gitignore"), "coverage/\n", "utf8");

    const first = await initProject({
      cwd: root,
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(first.created).toEqual(
      expect.arrayContaining([
        "docs/vision.md",
        "AGENTS.md",
        "CLAUDE.md",
        "build-product.ps1",
        "pipeline.config.json",
        ".gitignore (updated)",
      ]),
    );
    await expect(readFile(join(root, "docs", "vision.md"), "utf8")).resolves
      .toContain("# Acme — Vision Document");
    await expect(readFile(join(root, ".gitignore"), "utf8")).resolves.toBe(
      "coverage/\nbuild-logs/\n",
    );

    await writeFile(
      join(root, "docs", "vision.md"),
      "User-authored vision.\n",
      "utf8",
    );
    const second = await initProject({
      cwd: root,
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(second.skipped).toContain("docs/vision.md");
    await expect(readFile(join(root, "docs", "vision.md"), "utf8")).resolves.toBe(
      "User-authored vision.\n",
    );
  });
});
