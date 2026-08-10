import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectManifest,
  toPackageName,
} from "../src/project-manifest.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix = "program-pipeline-manifest-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("toPackageName", () => {
  it.each([
    ["switchboard", "switchboard"],
    ["My Project", "my-project"],
    ["Acme Dashboard!!", "acme-dashboard"],
    [".hidden", "hidden"],
    ["_private", "private"],
    ["   ", "project"],
    ["!!!", "project"],
  ])("normalizes %j to %j", (directory, expected) => {
    expect(toPackageName(directory)).toBe(expected);
  });

  it("truncates to the npm name length limit", () => {
    expect(toPackageName("a".repeat(300))).toHaveLength(214);
  });
});

describe("createProjectManifest", () => {
  it("writes a private placeholder manifest in an empty directory", async () => {
    const root = await temporaryRoot();

    const result = await createProjectManifest(root);

    expect(result.created).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    expect(manifest).toEqual({
      name: result.name,
      version: "0.0.0",
      private: true,
    });
  });

  it("never writes a stub test script that would poison verify commands", async () => {
    const root = await temporaryRoot();

    await createProjectManifest(root);

    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    expect(manifest.scripts).toBeUndefined();
  });

  it("leaves an existing package.json untouched", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "package.json"), '{"name":"existing"}');

    const result = await createProjectManifest(root);

    expect(result).toMatchObject({
      created: false,
      reason: "package.json exists",
    });
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      '{"name":"existing"}',
    );
  });

  it.each([["go.mod"], ["pyproject.toml"], ["Cargo.toml"], ["app.csproj"]])(
    "declines to create one next to %s",
    async (manifestFile) => {
      const root = await temporaryRoot();
      await writeFile(join(root, manifestFile), "");

      const result = await createProjectManifest(root);

      expect(result).toMatchObject({
        created: false,
        reason: "foreign manifest",
        foreignManifest: manifestFile,
      });
    },
  );

  it("derives the package name from the directory name", async () => {
    const root = await temporaryRoot("Program Pipeline Demo ");

    const result = await createProjectManifest(root);

    expect(result.name).toMatch(/^program-pipeline-demo-/u);
  });
});
