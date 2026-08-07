import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDevDependencyCommand,
  detectPackageManager,
  isPnpmWorkspaceRoot,
  parsePackageManager,
} from "../src/detect-package-manager.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-pm-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("detectPackageManager", () => {
  it("prefers the packageManager field over lockfiles", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.2.1" }),
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "");

    expect(detectPackageManager(root)).toBe("yarn");
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("detects %s as %s", async (lockfile, manager) => {
    const root = await temporaryRoot();
    await writeFile(join(root, lockfile), "");

    expect(detectPackageManager(root)).toBe(manager);
  });

  it("walks up from a workspace package to the repository root", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    const packageDirectory = join(root, "packages", "app");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "app" }),
    );

    expect(detectPackageManager(packageDirectory)).toBe("pnpm");
  });

  it("ignores a malformed package.json and an unknown packageManager", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "package.json"), "{not json");
    await writeFile(join(root, "yarn.lock"), "");
    expect(detectPackageManager(root)).toBe("yarn");

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "vlt@1.0.0" }),
    );
    expect(detectPackageManager(root)).toBe("yarn");
  });

  it("falls back to npm when nothing is found", async () => {
    const root = await temporaryRoot();

    expect(detectPackageManager(root)).toBe("npm");
  });
});

describe("parsePackageManager", () => {
  it("accepts known managers case-insensitively", () => {
    expect(parsePackageManager("PNPM")).toBe("pnpm");
    expect(parsePackageManager(" npm ")).toBe("npm");
  });

  it("rejects unknown managers", () => {
    expect(() => parsePackageManager("cargo")).toThrow(
      /unknown package manager "cargo"/,
    );
  });
});

describe("addDevDependencyCommand", () => {
  it.each([
    ["npm", "npm install --save-dev pkg"],
    ["pnpm", "pnpm add -D pkg"],
    ["yarn", "yarn add -D pkg"],
    ["bun", "bun add -d pkg"],
  ] as const)("maps %s to its add command", (manager, command) => {
    expect(addDevDependencyCommand(manager, "pkg")).toBe(command);
  });

  it("adds -w for pnpm at a workspace root", () => {
    expect(
      addDevDependencyCommand("pnpm", "pkg", { pnpmWorkspaceRoot: true }),
    ).toBe("pnpm add -D -w pkg");
    expect(
      addDevDependencyCommand("npm", "pkg", { pnpmWorkspaceRoot: true }),
    ).toBe("npm install --save-dev pkg");
  });
});

describe("isPnpmWorkspaceRoot", () => {
  it("is true only when pnpm-workspace.yaml exists", async () => {
    const root = await temporaryRoot();
    expect(isPnpmWorkspaceRoot(root)).toBe(false);

    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n");
    expect(isPnpmWorkspaceRoot(root)).toBe(true);
  });
});
