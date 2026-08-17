import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectCopies,
  installSkills,
  parseTargets,
  RETIRED_WORKFLOWS,
  WORKFLOWS,
} from "../src/install-skills.js";

/**
 * Reproduces the installer's provenance marker, so a test can plant a file
 * that an older version of this package would have written.
 */
function withMarker(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n");
  const hash = createHash("sha256").update(normalized).digest("hex");
  const insertAt = normalized.indexOf("\n---\n", 4) + 5;
  return `${normalized.slice(0, insertAt)}<!-- program-pipeline:sha256=${hash} -->\n${normalized.slice(insertAt)}`;
}

async function plantRetiredSkill(
  skillsRoot: string,
  name: string,
  options: { edited?: boolean } = {},
): Promise<string> {
  const body = `---\nname: ${name}\ndescription: A skill an older install wrote.\n---\n\n# ${name}\n\nAuthor the specs yourself in this session.\n`;
  const content = withMarker(body);
  await mkdir(join(skillsRoot, name), { recursive: true });
  const path = join(skillsRoot, name, "SKILL.md");
  await writeFile(path, options.edited ? `${content}\nMy own note.\n` : content, "utf8");
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
      targets: ["cursor", "claude", "openclaw", "codex", "gemini"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length * 5);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(
      readFile(
        join(root, ".cursor", "skills", "plan-program", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
    await expect(
      readFile(
        join(root, ".agents", "skills", "init-project", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
    await expect(
      readFile(
        join(root, ".gemini", "skills", "plan-program", "SKILL.md"),
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

describe("installSkills at user scope", () => {
  it("writes into the resolved home roots, not the project", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude", "codex"],
      scopes: ["user"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length * 2);
    await expect(
      readFile(
        join(home, ".claude", "skills", "plan-program", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
    // Codex reads the cross-tool tree.
    await expect(
      readFile(
        join(home, ".agents", "skills", "plan-program", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("program-pipeline:sha256=");
    expect(await exists(join(root, ".claude"))).toBe(false);
  });

  it("honours a per-target root override", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const custom = join(root, "custom-claude");

    await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
      roots: { claude: custom },
    });

    await expect(
      readFile(join(custom, "plan-program", "SKILL.md"), "utf8"),
    ).resolves.toContain("program-pipeline:sha256=");
    expect(await exists(join(home, ".claude", "skills"))).toBe(false);
  });

  it("writes both scopes when asked, without double-warning about itself", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user", "project"],
    });

    expect(result.installed).toHaveLength(WORKFLOWS.length * 2);
    expect(result.warnings).toEqual([]);
    expect(
      await exists(join(home, ".claude", "skills", "plan-program", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(root, ".claude", "skills", "plan-program", "SKILL.md")),
    ).toBe(true);
  });

  it("flags shadowing project copies as package-managed warnings", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "project",
          kind: "skill",
          packageManaged: true,
        }),
      ]),
    );
  });
});

describe("pruning project copies", () => {
  it("removes unmodified copies and cleans up the empty directories", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
      pruneProject: true,
    });

    expect(result.pruned).toHaveLength(WORKFLOWS.length);
    expect(result.pruneSkipped).toEqual([]);
    expect(await exists(join(root, ".claude", "skills"))).toBe(false);
    expect(
      await exists(join(home, ".claude", "skills", "plan-program", "SKILL.md")),
    ).toBe(true);
  });

  it("keeps copies the user edited and reports them", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const edited = join(root, ".claude", "skills", "plan-program", "SKILL.md");
    const original = await readFile(edited, "utf8");
    await writeFile(edited, `${original}\nLocal customization.\n`, "utf8");

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
      pruneProject: true,
    });

    expect(result.pruneSkipped).toEqual([
      join(".claude", "skills", "plan-program", "SKILL.md"),
    ]);
    expect(result.pruned).toHaveLength(WORKFLOWS.length - 1);
    await expect(readFile(edited, "utf8")).resolves.toContain(
      "Local customization.",
    );
  });

  it("never prunes while the project scope is also a destination", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user", "project"],
      pruneProject: true,
    });

    expect(result.pruned).toEqual([]);
    expect(
      await exists(join(root, ".claude", "skills", "plan-program", "SKILL.md")),
    ).toBe(true);
  });

  it("leaves everything in place when a conflict aborts the install", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const blocking = join(
      home,
      ".claude",
      "skills",
      "plan-program",
      "SKILL.md",
    );
    await mkdir(dirname(blocking), { recursive: true });
    await writeFile(blocking, "user-authored\n", "utf8");

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
      pruneProject: true,
    });

    expect(result.aborted).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(
      await exists(join(root, ".claude", "skills", "plan-program", "SKILL.md")),
    ).toBe(true);
  });
});

describe("findProjectCopies", () => {
  it("separates package-managed copies from edited ones", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const edited = join(root, ".claude", "skills", "plan-program", "SKILL.md");
    await writeFile(edited, `${await readFile(edited, "utf8")}\nedit\n`, "utf8");

    const copies = await findProjectCopies(root, ["claude"], { home });

    expect(copies.managed).toHaveLength(WORKFLOWS.length - 1);
    expect(copies.modified).toEqual([
      join(".claude", "skills", "plan-program", "SKILL.md"),
    ]);
  });

  it("reports nothing for a project that was never installed into", async () => {
    const root = await temporaryRoot();

    const copies = await findProjectCopies(root, ["claude", "cursor"], {
      home: join(root, "home"),
    });

    expect(copies).toEqual({ managed: [], modified: [] });
  });
});

describe("retired workflows", () => {
  it("no longer ships the skills whose work became a command", () => {
    // Belt and braces: a name in both lists would install and then delete
    // itself on every run.
    for (const retired of RETIRED_WORKFLOWS) {
      expect(WORKFLOWS).not.toContain(retired);
    }
    expect(RETIRED_WORKFLOWS).toContain("author-workstreams");
    expect(RETIRED_WORKFLOWS).toContain("build-program");
  });

  it("removes an unmodified retired skill an older install left behind", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const planted = await plantRetiredSkill(
      join(root, ".claude", "skills"),
      "author-workstreams",
    );

    const result = await installSkills({ cwd: root, home, targets: ["claude"] });

    expect(result.retired).toContain(
      join(".claude", "skills", "author-workstreams", "SKILL.md"),
    );
    expect(await exists(planted)).toBe(false);
    // Its directory goes too, rather than leaving empty scaffolding.
    expect(
      await exists(join(root, ".claude", "skills", "author-workstreams")),
    ).toBe(false);
  });

  it("keeps an edited retired skill and reports it instead of deleting", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const planted = await plantRetiredSkill(
      join(root, ".claude", "skills"),
      "build-program",
      { edited: true },
    );

    const result = await installSkills({ cwd: root, home, targets: ["claude"] });

    expect(result.retiredKept).toContain(
      join(".claude", "skills", "build-program", "SKILL.md"),
    );
    expect(result.retired).not.toContain(
      join(".claude", "skills", "build-program", "SKILL.md"),
    );
    await expect(readFile(planted, "utf8")).resolves.toContain("My own note.");
  });

  it("removes retired skills at user scope too", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const planted = await plantRetiredSkill(
      join(home, ".claude", "skills"),
      "update-as-built",
    );

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
    });

    expect(result.retired).toContain(planted);
    expect(await exists(planted)).toBe(false);
  });

  it("removes retired project-scope copies during a user-scope install", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    // The shape a project left in by an install from before user scope became
    // the default: project copies a user-scope run would never look at, in
    // the scope the agent still reads.
    const planted = await plantRetiredSkill(
      join(root, ".claude", "skills"),
      "author-workstreams",
    );

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["user"],
    });

    expect(result.retired).toContain(
      join(".claude", "skills", "author-workstreams", "SKILL.md"),
    );
    expect(await exists(planted)).toBe(false);
  });

  it("removes retired user-scope copies during a project-scope install", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const planted = await plantRetiredSkill(
      join(home, ".claude", "skills"),
      "review-program",
    );

    const result = await installSkills({
      cwd: root,
      home,
      targets: ["claude"],
      scopes: ["project"],
    });

    expect(result.retired).toContain(planted);
    expect(await exists(planted)).toBe(false);
  });

  it("reports nothing when no retired skill is installed", async () => {
    const root = await temporaryRoot();
    const result = await installSkills({
      cwd: root,
      home: join(root, "home"),
      targets: ["claude"],
    });

    expect(result.retired).toEqual([]);
    expect(result.retiredKept).toEqual([]);
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
