import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSkills,
  parseTargets,
  WORKFLOWS,
} from "../src/install-skills.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-skills-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("installSkills", () => {
  it("installs every workflow for every supported agent", async () => {
    const root = await temporaryRoot();

    const result = await installSkills({
      cwd: root,
      targets: ["cursor", "claude", "openclaw"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length * 3);
    expect(result.conflicts).toEqual([]);
    await expect(
      readFile(
        join(root, ".cursor", "skills", "plan-program", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
  });

  it("is idempotent for generated files", async () => {
    const root = await temporaryRoot();
    await installSkills({ cwd: root, targets: ["cursor"] });

    const second = await installSkills({ cwd: root, targets: ["cursor"] });

    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toHaveLength(WORKFLOWS.length);
  });

  it("does not replace a generated file that a user subsequently edits", async () => {
    const root = await temporaryRoot();
    await installSkills({ cwd: root, targets: ["cursor"] });
    const destination = join(
      root,
      ".cursor",
      "skills",
      "plan-program",
      "SKILL.md",
    );
    const generated = await readFile(destination, "utf8");
    await writeFile(destination, `${generated}\nUser customization.\n`, "utf8");

    const result = await installSkills({ cwd: root, targets: ["cursor"] });

    expect(result.conflicts).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
  });

  it("preserves user-authored collisions unless forced", async () => {
    const root = await temporaryRoot();
    const destination = join(
      root,
      ".cursor",
      "skills",
      "plan-program",
      "SKILL.md",
    );
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, "user-authored\n", "utf8");

    const safe = await installSkills({ cwd: root, targets: ["cursor"] });
    expect(safe.conflicts).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("user-authored\n");

    const forced = await installSkills({
      cwd: root,
      targets: ["cursor"],
      force: true,
    });
    expect(forced.updated).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
  });
});

describe("parseTargets", () => {
  it("deduplicates targets and rejects unknown values", () => {
    expect(parseTargets("cursor, cursor,openclaw")).toEqual([
      "cursor",
      "openclaw",
    ]);
    expect(() => parseTargets("cursor,other")).toThrow("Unknown target");
  });
});
