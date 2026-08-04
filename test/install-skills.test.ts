import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      home: join(root, "home"),
      targets: ["cursor", "claude", "openclaw"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length * 3);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(
      readFile(
        join(root, ".cursor", "skills", "plan-program", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
  });

  it("is idempotent for generated files", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["cursor"] });

    const second = await installSkills({ cwd: root, home, targets: ["cursor"] });

    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toHaveLength(WORKFLOWS.length);
  });

  it("does not replace a generated file that a user subsequently edits", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["cursor"] });
    const destination = join(
      root,
      ".cursor",
      "skills",
      "plan-program",
      "SKILL.md",
    );
    const generated = await readFile(destination, "utf8");
    await writeFile(destination, `${generated}\nUser customization.\n`, "utf8");

    const result = await installSkills({ cwd: root, home, targets: ["cursor"] });

    expect(result.conflicts).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
    expect(result.aborted).toBe(true);
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
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "user-authored\n", "utf8");

    const home = join(root, "home");
    const safe = await installSkills({ cwd: root, home, targets: ["cursor"] });
    expect(safe.conflicts).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
    expect(safe.aborted).toBe(true);
    await expect(
      readFile(
        join(root, ".cursor", "skills", "init-project", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(destination, "utf8")).resolves.toBe("user-authored\n");

    const forced = await installSkills({
      cwd: root,
      home,
      targets: ["cursor"],
      force: true,
    });
    expect(forced.updated).toContain(
      join(".cursor", "skills", "plan-program", "SKILL.md"),
    );
  });

  it("aborts an openclaw install when the project's skills/ directory already has unrelated content", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const existing = join(root, "skills", "plan-program", "SKILL.md");
    await mkdir(dirname(existing), { recursive: true });
    await writeFile(existing, "project-owned skill\n", "utf8");

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["openclaw"],
    });

    expect(result.aborted).toBe(true);
    expect(result.conflicts).toContain(
      join("skills", "plan-program", "SKILL.md"),
    );
    await expect(readFile(existing, "utf8")).resolves.toBe(
      "project-owned skill\n",
    );
    await expect(
      readFile(join(root, "skills", "build-program", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warns about existing commands and alternate skills before writing", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const definitions = [
      join(root, ".cursor", "commands", "plan-program.md"),
      join(root, ".agents", "skills", "review-program", "SKILL.md"),
      join(home, ".cursor", "commands", "build-program.md"),
      join(home, ".cursor", "skills", "update-as-built", "SKILL.md"),
    ];
    for (const definition of definitions) {
      await mkdir(dirname(definition), { recursive: true });
      await writeFile(definition, "existing definition\n", "utf8");
    }

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["cursor"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: "plan-program",
          kind: "command",
          scope: "project",
        }),
        expect.objectContaining({
          workflow: "review-program",
          kind: "skill",
          scope: "project",
        }),
        expect.objectContaining({
          workflow: "build-program",
          kind: "command",
          scope: "user",
        }),
        expect.objectContaining({
          workflow: "update-as-built",
          kind: "skill",
          scope: "user",
        }),
      ]),
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
