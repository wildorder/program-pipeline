import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorktree, restoreWorktree } from "../src/worktree-guard.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-worktree-"));
  roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "commit.gpgsign", "false");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "tracked.txt"), "one\n", "utf8");
  await writeFile(join(root, "docs", "plan.md"), "plan-v1\n", "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial");
  return root;
}

describe("worktree guard", () => {
  it("restores tracked drift to the captured (not HEAD) state, deletes new untracked files, and preserves exclusions", async () => {
    const root = await gitFixture();
    // Dirty before capture: the capture, not HEAD, is the rollback target.
    await writeFile(join(root, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(root, "preexisting-untracked.txt"), "keep me\n", "utf8");
    const capture = await captureWorktree(root);
    expect(capture.available).toBe(true);

    // Simulated agent: edits an out-of-scope tracked file (dirty at capture),
    // edits the preserved plan file, and litters a temp script.
    await writeFile(join(root, "tracked.txt"), "three\n", "utf8");
    await writeFile(join(root, "docs", "plan.md"), "plan-v2\n", "utf8");
    await writeFile(join(root, ".tmp-replan17.cjs"), "console.log(1)\n", "utf8");

    const result = await restoreWorktree(root, capture, [join(root, "docs", "plan.md")]);
    expect(result.restored).toBe(true);
    expect(result.drifted).toContain("tracked.txt");
    expect(result.drifted).not.toContain("docs/plan.md");
    expect(result.removed).toEqual([".tmp-replan17.cjs"]);
    await expect(readFile(join(root, "tracked.txt"), "utf8")).resolves.toBe("two\n");
    await expect(readFile(join(root, "docs", "plan.md"), "utf8")).resolves.toBe("plan-v2\n");
    await expect(readFile(join(root, "preexisting-untracked.txt"), "utf8")).resolves.toBe("keep me\n");
    await expect(readFile(join(root, ".tmp-replan17.cjs"), "utf8")).rejects.toThrow();
  });

  it("restores a tracked file the agent deleted", async () => {
    const root = await gitFixture();
    const capture = await captureWorktree(root);
    await rm(join(root, "tracked.txt"));
    const result = await restoreWorktree(root, capture);
    expect(result.drifted).toContain("tracked.txt");
    await expect(readFile(join(root, "tracked.txt"), "utf8")).resolves.toBe("one\n");
  });

  it("reports unavailable outside a git repository and restores nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "program-pipeline-nogit-"));
    roots.push(root);
    const capture = await captureWorktree(root);
    expect(capture.available).toBe(false);
    const result = await restoreWorktree(root, capture);
    expect(result.restored).toBe(false);
  });
});
