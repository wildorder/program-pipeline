import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadInstallPrefs,
  PREFS_PATH,
  saveInstallPrefs,
} from "../src/install-prefs.js";
import { installSkills } from "../src/install-skills.js";
import { planSkillInstall, scopesFor } from "../src/install-wizard.js";
import type { PromptStreams } from "../src/prompt.js";

const ENTER = "\r";
const CTRL_C = String.fromCharCode(3);
const DOWN = `${String.fromCharCode(27)}[B`;
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-wizard-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

/**
 * Delivers scripted keystrokes as each prompt registers its listener, so a
 * test can queue the whole conversation up front without racing the async
 * work that happens between screens.
 */
class ScriptedInput {
  isTTY = true;
  private queue: string[];
  private listener: ((chunk: string) => void) | undefined;

  constructor(keys: string[]) {
    this.queue = [...keys];
  }
  setRawMode(): this {
    return this;
  }
  setEncoding(): void {}
  on(_event: "data", listener: (chunk: string) => void): void {
    this.listener = listener;
    this.flush();
  }
  off(): void {
    this.listener = undefined;
  }
  resume(): void {}
  pause(): void {}
  private flush(): void {
    while (this.listener && this.queue.length > 0) {
      this.listener(this.queue.shift() as string);
    }
  }
  get remaining(): number {
    return this.queue.length;
  }
}

class FakeOutput {
  isTTY = true;
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  get text(): string {
    return this.chunks.join("");
  }
}

function scripted(keys: string[]): {
  streams: PromptStreams;
  output: FakeOutput;
  input: ScriptedInput;
} {
  const input = new ScriptedInput(keys);
  const output = new FakeOutput();
  return { streams: { input, output }, output, input };
}

const silent = (): void => {};

describe("planSkillInstall (non-interactive)", () => {
  it("falls back to the detected tools and user scope", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".cursor"), { recursive: true });
    const lines: string[] = [];

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      log: (line) => lines.push(line),
    });

    expect(plan.targets.sort()).toEqual(["claude", "cursor"]);
    expect(plan.scopes).toEqual(["user"]);
    expect(plan.pruneProject).toBe(false);
    expect(plan.cancelled).toBe(false);
    expect(lines.join("\n")).toContain("non-interactive");
  });

  it("installs every target when no tool is detected", async () => {
    const root = await temporaryRoot();

    const plan = await planSkillInstall({
      cwd: root,
      home: join(root, "home"),
      env: {},
      log: silent,
    });

    expect(plan.targets).toHaveLength(5);
  });

  it("prefers saved preferences over detection", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await saveInstallPrefs({ targets: ["gemini"], scope: "project" }, home);

    const plan = await planSkillInstall({ cwd: root, home, env: {}, log: silent });

    expect(plan.targets).toEqual(["gemini"]);
    expect(plan.scopes).toEqual(["project"]);
  });

  it("lets explicit flags win over preferences", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await saveInstallPrefs({ targets: ["gemini"], scope: "project" }, home);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      explicitTargets: ["claude"],
      explicitScope: "both",
      log: silent,
    });

    expect(plan.targets).toEqual(["claude"]);
    expect(plan.scopes).toEqual(["user", "project"]);
  });

  it("does not prompt when a TTY is present but --yes was passed", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const { streams, output, input } = scripted([ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      yes: true,
      streams,
      log: silent,
    });

    expect(plan.targets).toEqual(["claude"]);
    expect(output.text).toBe("");
    expect(input.remaining).toBe(1);
  });

  it("does not prompt when --targets was passed", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const { streams, output } = scripted([ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      explicitTargets: ["codex"],
      streams,
      log: silent,
    });

    expect(plan.targets).toEqual(["codex"]);
    expect(output.text).toBe("");
  });

  it("treats a CI marker as non-interactive", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const { streams, output } = scripted([ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: { CI: "true" },
      streams,
      log: silent,
    });

    expect(plan.targets).toEqual(["cursor"]);
    expect(output.text).toBe("");
  });
});

describe("planSkillInstall (interactive)", () => {
  it("accepts the detected defaults and records them", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const { streams, output } = scripted([ENTER, ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(plan.targets).toEqual(["claude"]);
    expect(plan.scopes).toEqual(["user"]);
    expect(plan.cancelled).toBe(false);
    expect(output.text).toContain("Where should the workflow skills go?");
    expect(output.text).toContain("Claude Code");
    expect(output.text).toContain("not detected");
    await expect(loadInstallPrefs(home)).resolves.toEqual({
      targets: ["claude"],
      scope: "user",
    });
  });

  it("records a project-scope choice from the second screen", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const { streams } = scripted([ENTER, `${DOWN}${ENTER}`]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(plan.scopes).toEqual(["project"]);
    await expect(loadInstallPrefs(home)).resolves.toMatchObject({
      scope: "project",
    });
  });

  it("opens with the saved preference rather than detection", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".cursor"), { recursive: true });
    await saveInstallPrefs({ targets: ["gemini"], scope: "user" }, home);
    const { streams } = scripted([ENTER, ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(plan.targets).toEqual(["gemini"]);
  });

  it("offers to remove project copies that would shadow the install", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const { streams, output } = scripted([ENTER, ENTER, ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(output.text).toContain("Remove them?");
    expect(plan.pruneProject).toBe(true);
  });

  it("skips the prune question when nothing would shadow", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const { streams, output } = scripted([ENTER, ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(output.text).not.toContain("Remove them?");
    expect(plan.pruneProject).toBe(false);
  });

  it("skips the prune question for a project-scope install", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const { streams, output } = scripted([ENTER, `${DOWN}${ENTER}`]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(plan.scopes).toEqual(["project"]);
    expect(output.text).not.toContain("Remove them?");
    expect(plan.pruneProject).toBe(false);
  });

  it("reports edited project copies that will keep shadowing", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await installSkills({ cwd: root, home, targets: ["claude"] });
    const edited = join(root, ".claude", "skills", "plan-program", "SKILL.md");
    await writeFile(edited, `${await readFile(edited, "utf8")}\nlocal edit\n`, "utf8");
    const lines: string[] = [];
    const { streams } = scripted([ENTER, ENTER, ENTER]);

    await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: (line) => lines.push(line),
    });

    expect(lines.join("\n")).toContain("keep shadowing");
    expect(lines.join("\n")).toContain("plan-program");
  });

  it("cancels without writing preferences", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const { streams } = scripted([CTRL_C]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: silent,
    });

    expect(plan.cancelled).toBe(true);
    expect(plan.targets).toEqual([]);
    await expect(loadInstallPrefs(home)).resolves.toBeUndefined();
  });

  it("cancels when every target is deselected", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const lines: string[] = [];
    // The first "a" selects every row; the second clears them all.
    const { streams } = scripted(["a", "a", ENTER]);

    const plan = await planSkillInstall({
      cwd: root,
      home,
      env: {},
      streams,
      log: (line) => lines.push(line),
    });

    expect(plan.cancelled).toBe(true);
    expect(lines.join("\n")).toContain("no targets selected");
  });
});

describe("install preferences", () => {
  it("round-trips through the user home", async () => {
    const home = await temporaryRoot();

    const path = await saveInstallPrefs(
      { targets: ["claude", "codex"], scope: "both" },
      home,
    );

    expect(path).toBe(join(home, PREFS_PATH));
    await expect(loadInstallPrefs(home)).resolves.toEqual({
      targets: ["claude", "codex"],
      scope: "both",
    });
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
    };
    expect(raw.schemaVersion).toBe(1);
  });

  it("ignores a corrupt or unusable file instead of failing the install", async () => {
    const home = await temporaryRoot();
    const path = join(home, PREFS_PATH);
    await mkdir(join(home, ".program-pipeline"), { recursive: true });

    await writeFile(path, "{not json", "utf8");
    await expect(loadInstallPrefs(home)).resolves.toBeUndefined();

    await writeFile(path, JSON.stringify({ schemaVersion: 9 }), "utf8");
    await expect(loadInstallPrefs(home)).resolves.toBeUndefined();

    await expect(loadInstallPrefs(join(home, "missing"))).resolves.toBeUndefined();
  });

  it("drops targets a newer version wrote and keeps the rest", async () => {
    const home = await temporaryRoot();
    await mkdir(join(home, ".program-pipeline"), { recursive: true });
    await writeFile(
      join(home, PREFS_PATH),
      JSON.stringify({
        schemaVersion: 1,
        targets: ["claude", "future-tool"],
        scope: "user",
      }),
      "utf8",
    );

    await expect(loadInstallPrefs(home)).resolves.toEqual({
      targets: ["claude"],
      scope: "user",
    });
  });

  it("treats a file with no recognisable target as absent", async () => {
    const home = await temporaryRoot();
    await mkdir(join(home, ".program-pipeline"), { recursive: true });
    await writeFile(
      join(home, PREFS_PATH),
      JSON.stringify({ schemaVersion: 1, targets: ["future-tool"], scope: "user" }),
      "utf8",
    );

    await expect(loadInstallPrefs(home)).resolves.toBeUndefined();
  });
});

describe("scopesFor", () => {
  it("expands both into an ordered pair", () => {
    expect(scopesFor("both")).toEqual(["user", "project"]);
    expect(scopesFor("user")).toEqual(["user"]);
    expect(scopesFor("project")).toEqual(["project"]);
  });
});
