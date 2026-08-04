import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(first.created).toEqual(
      expect.arrayContaining([
        "docs/vision.md",
        "AGENTS.md",
        "CLAUDE.md",
        "pipeline.config.json",
        ".gitignore (updated)",
      ]),
    );
    await expect(readFile(join(root, "docs", "vision.md"), "utf8")).resolves
      .toContain("# Acme — Vision Document");
    const config = JSON.parse(
      await readFile(join(root, "pipeline.config.json"), "utf8"),
    ) as { verify: Record<string, string> };
    expect(config.verify).toEqual({});
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
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(second.skipped).toContain("docs/vision.md");
    await expect(readFile(join(root, "docs", "vision.md"), "utf8")).resolves.toBe(
      "User-authored vision.\n",
    );
  });

  it("prefills verify commands from package.json scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "acme",
        scripts: { build: "tsc", test: "vitest run", start: "node ." },
      }),
      "utf8",
    );

    await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    const config = JSON.parse(
      await readFile(join(root, "pipeline.config.json"), "utf8"),
    ) as { verify: Record<string, string> };
    expect(config.verify).toEqual({
      build: "npm run build",
      test: "npm test",
    });
  });

  it("merges the universal block into an existing AGENTS.md and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "AGENTS.md"),
      "# House rules\n\nAlways use tabs.\n",
      "utf8",
    );

    const first = await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });
    expect(first.updated).toContain("AGENTS.md (universal block added)");

    const merged = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(merged.startsWith("<!-- BEGIN UNIVERSAL")).toBe(true);
    expect(merged).toContain("VERIFY BEFORE CLAIMING COMPLETION");
    expect(merged).toContain("# House rules");
    expect(merged).toContain("Always use tabs.");

    const second = await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });
    expect(second.updated).toEqual([]);
    expect(second.skipped).toContain("AGENTS.md");
  });

  it("refreshes an outdated universal block without touching other content", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "AGENTS.md"),
      "<!-- BEGIN UNIVERSAL — source: old -->\nOld directives.\n<!-- END UNIVERSAL -->\n\n## Project notes\n\nKeep these.\n",
      "utf8",
    );

    const result = await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(result.updated).toContain("AGENTS.md (universal block updated)");
    const content = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(content).not.toContain("Old directives.");
    expect(content).toContain("VERIFY BEFORE CLAIMING COMPLETION");
    expect(content).toContain("Keep these.");
  });

  it("resolves name and description from package.json and detects the stack", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "acme-app",
        description: "Acme delivery app.",
        engines: { node: ">=20" },
        dependencies: { express: "^5.1.0" },
        devDependencies: { typescript: "^5.9.0", vitest: "^4.0.0" },
      }),
      "utf8",
    );

    const result = await initProject({
      cwd: root,
      home: join(root, "home"),
    });
    expect(result.warnings).toEqual([]);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Project: acme-app");
    expect(agents).toContain("TypeScript on Node >=20");
    expect(agents).toContain("Express");
    expect(agents).toContain("| express | ^5.1.0 |");
    await expect(
      readFile(join(root, "docs", "vision.md"), "utf8"),
    ).resolves.toContain("Acme delivery app.");
  });

  it("fails clearly when no name can be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);

    await expect(
      initProject({ cwd: root, home: join(root, "home") }),
    ).rejects.toThrow("pass --name");
  });

  it("records existing markdown documentation as contextDocs", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "README.md"), "# Readme\n", "utf8");
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await writeFile(
      join(root, "docs", "adr", "001-choice.md"),
      "# ADR\n",
      "utf8",
    );
    await mkdir(join(root, "docs", "programs"), { recursive: true });
    await writeFile(
      join(root, "docs", "programs", "old-program.md"),
      "# Old\n",
      "utf8",
    );

    await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    const config = JSON.parse(
      await readFile(join(root, "pipeline.config.json"), "utf8"),
    ) as { contextDocs: string[] };
    expect(config.contextDocs).toEqual(["README.md", "docs/adr/001-choice.md"]);
  });

  it("uses the packaged universal directives by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);

    const result = await initProject({
      cwd: root,
      home: join(root, "home"),
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });

    expect(result.warnings).toEqual([]);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("source: @wildorder/program-pipeline packaged default");
    expect(agents).toContain("VERIFY BEFORE CLAIMING COMPLETION");
  });

  it("prefers the user override over the packaged default", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const override = join(home, ".program-pipeline", "universal-directives.md");
    await mkdir(dirname(override), { recursive: true });
    await writeFile(override, "# Team directives\n", "utf8");

    const overrideResult = await initProject({
      cwd: join(root, "override-project"),
      home,
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });
    expect(overrideResult.warnings).toEqual([]);
    await expect(
      readFile(join(root, "override-project", "AGENTS.md"), "utf8"),
    ).resolves.toContain("# Team directives");
  });

  it("honors an explicit directives path and fails when it is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-init-"));
    temporaryRoots.push(root);
    const explicit = join(root, "org-directives.md");
    await writeFile(explicit, "# Org directives\n", "utf8");

    await initProject({
      cwd: join(root, "project"),
      home: join(root, "home"),
      directivesPath: explicit,
      name: "Acme",
      stack: "TypeScript/Node",
      description: "Coordinates acme delivery.",
    });
    await expect(
      readFile(join(root, "project", "AGENTS.md"), "utf8"),
    ).resolves.toContain("# Org directives");

    await expect(
      initProject({
        cwd: join(root, "other-project"),
        home: join(root, "home"),
        directivesPath: join(root, "missing.md"),
        name: "Acme",
        stack: "TypeScript/Node",
        description: "Coordinates acme delivery.",
      }),
    ).rejects.toThrow("Universal directives override not found");
  });
});
