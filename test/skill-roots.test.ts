import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_TARGETS,
  detectTargets,
  overrideEnvName,
  parseRootOverrides,
  parseTargets,
  scanRoots,
} from "../src/skill-roots.js";

const temporaryRoots: string[] = [];

async function temporaryHome(...present: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "program-pipeline-home-"));
  temporaryRoots.push(home);
  for (const dir of present) await mkdir(join(home, dir), { recursive: true });
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("detectTargets", () => {
  it("reports only the tools whose config directories exist", async () => {
    const home = await temporaryHome(".claude", ".cursor");

    const detected = await detectTargets({ home, env: {} });
    const present = detected
      .filter((entry) => entry.detected)
      .map((entry) => entry.target);

    expect(present.sort()).toEqual(["claude", "cursor"]);
    expect(detected).toHaveLength(ALL_TARGETS.length);
  });

  it("resolves default user roots under the home directory", async () => {
    const home = await temporaryHome();

    const detected = await detectTargets({ home, env: {} });
    const roots = Object.fromEntries(
      detected.map((entry) => [entry.target, entry.userRoot]),
    );

    expect(roots.claude).toBe(join(home, ".claude", "skills"));
    expect(roots.cursor).toBe(join(home, ".cursor", "skills"));
    expect(roots.gemini).toBe(join(home, ".gemini", "skills"));
    expect(roots.openclaw).toBe(join(home, ".openclaw", "skills"));
    // Codex reads the cross-tool tree, not its own config directory.
    expect(roots.codex).toBe(join(home, ".agents", "skills"));
    expect(detected.every((entry) => entry.source === "default")).toBe(true);
  });

  it("prefers an explicit root over both environment layers", async () => {
    const home = await temporaryHome();
    const flag = join(home, "explicit");

    const [claude] = await detectTargets({
      home,
      roots: { claude: flag },
      env: {
        CLAUDE_CONFIG_DIR: join(home, "relocated"),
        [overrideEnvName("claude")]: join(home, "from-env"),
      },
    });

    expect(claude?.userRoot).toBe(flag);
    expect(claude?.source).toBe("flag");
  });

  it("prefers the package override variable over the tool's own variable", async () => {
    const home = await temporaryHome();

    const detected = await detectTargets({
      home,
      env: {
        CLAUDE_CONFIG_DIR: join(home, "relocated"),
        [overrideEnvName("claude")]: join(home, "from-env"),
      },
    });
    const claude = detected.find((entry) => entry.target === "claude");

    expect(claude?.userRoot).toBe(join(home, "from-env"));
    expect(claude?.source).toBe("env");
  });

  it("follows the tool's own config-home variable when nothing overrides it", async () => {
    const home = await temporaryHome();
    const relocated = join(home, "relocated");
    await mkdir(relocated, { recursive: true });

    const detected = await detectTargets({
      home,
      env: { CLAUDE_CONFIG_DIR: relocated },
    });
    const claude = detected.find((entry) => entry.target === "claude");

    expect(claude?.userRoot).toBe(join(relocated, "skills"));
    expect(claude?.source).toBe("env");
    expect(claude?.detected).toBe(true);
  });

  it("lets CODEX_HOME move detection without moving the shared write root", async () => {
    const home = await temporaryHome();
    const codexHome = join(home, "elsewhere", ".codex");
    await mkdir(codexHome, { recursive: true });

    const detected = await detectTargets({
      home,
      env: { CODEX_HOME: codexHome },
    });
    const codex = detected.find((entry) => entry.target === "codex");

    expect(codex?.detected).toBe(true);
    expect(codex?.userRoot).toBe(join(home, ".agents", "skills"));
    expect(codex?.source).toBe("default");
  });
});

describe("parseRootOverrides", () => {
  it("maps target=path entries and rejects malformed ones", () => {
    const parsed = parseRootOverrides(["claude=/opt/claude", "cursor=/opt/cursor"]);

    expect(parsed.claude).toContain("opt");
    expect(Object.keys(parsed).sort()).toEqual(["claude", "cursor"]);
    expect(() => parseRootOverrides(["claude"])).toThrow("expected <target>=<path>");
    expect(() => parseRootOverrides(["=/opt"])).toThrow("expected <target>=<path>");
    expect(() => parseRootOverrides(["nope=/opt"])).toThrow("Unknown target");
  });
});

describe("scanRoots", () => {
  it("covers both scopes plus the command and cross-tool trees", async () => {
    const home = await temporaryHome();
    const detected = await detectTargets({ home, env: {} });

    const roots = scanRoots(detected, "/project", home).map((entry) => entry.root);

    expect(roots).toContain(join("/project", ".claude", "skills"));
    expect(roots).toContain(join(home, ".claude", "skills"));
    expect(roots).toContain(join(home, ".claude", "commands"));
    expect(roots).toContain(join("/project", ".cursor", "commands"));
    // Codex's own skills directory is scanned even though writes go to .agents.
    expect(roots).toContain(join(home, ".codex", "skills"));
    expect(roots).toContain(join(home, ".openclaw", "workspace", "skills"));
  });
});

describe("parseTargets", () => {
  it("deduplicates targets and rejects unknown values", () => {
    expect(parseTargets("cursor, cursor,openclaw")).toEqual(["cursor", "openclaw"]);
    expect(() => parseTargets("cursor,other")).toThrow("Unknown target");
  });
});
