import { execFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

/** Symlinked temp dirs (macOS /tmp) make raw paths disagree with git's realpathed toplevel. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

const run = promisify(execFile);

/**
 * A pre-attempt snapshot of the git worktree. Rejected replanner attempts
 * were "rolled back" by restoring exactly two files, but the replanner is a
 * full agentic CLI that can touch anything — out-of-scope edits and stray
 * temp scripts survived the rollback while the progress line claimed a clean
 * transaction. This guard makes the claim true: capture the whole tracked
 * tree via `git stash create` (which snapshots without touching the
 * worktree) and record which paths were untracked, so a restore can revert
 * every tracked change and delete files the agent created.
 *
 * Limits, stated rather than hidden: modifications to files that were
 * already untracked at capture time cannot be restored (git has no snapshot
 * of them), and gitignored files are invisible to the status listing. In a
 * non-git directory `available` is false and callers fall back to the
 * legacy two-file restore with a warning.
 */
export interface WorktreeCapture {
  available: boolean;
  /** Git repository toplevel; all recorded paths are relative to it. */
  toplevel?: string;
  /** Commit whose tree is the captured tracked state. */
  source?: string;
  /** Paths untracked at capture; never deleted by a restore. */
  untracked?: Set<string>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface StatusEntry {
  code: string;
  path: string;
}

function parseStatus(raw: string): StatusEntry[] {
  const tokens = raw.split("\0").filter((token) => token !== "");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const code = token.slice(0, 2);
    entries.push({ code, path: token.slice(3) });
    // Rename/copy entries carry the original path as a second NUL token.
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return entries;
}

export async function captureWorktree(root: string): Promise<WorktreeCapture> {
  try {
    const toplevel = (await git(resolve(root), ["rev-parse", "--show-toplevel"])).trim();
    const status = parseStatus(await git(toplevel, ["status", "--porcelain", "-z"]));
    const stash = (await git(toplevel, ["stash", "create"])).trim();
    return {
      available: true,
      toplevel,
      source: stash || "HEAD",
      untracked: new Set(status.filter(({ code }) => code === "??").map(({ path }) => path)),
    };
  } catch {
    return { available: false };
  }
}

export interface WorktreeRestoreResult {
  restored: boolean;
  /** Tracked paths whose state drifted from the capture (before restoring). */
  drifted: string[];
  /** Newly created untracked files that were deleted. */
  removed: string[];
}

const toPosix = (path: string): string => path.replaceAll("\\", "/");

/**
 * Revert the worktree to `capture`, except `preservePaths` (absolute or
 * root-relative), which keep their current content. Newly created untracked
 * files outside the preserve list are deleted.
 */
export async function restoreWorktree(
  root: string,
  capture: WorktreeCapture,
  preservePaths: string[] = [],
): Promise<WorktreeRestoreResult> {
  if (!capture.available || !capture.toplevel || !capture.source) {
    return { restored: false, drifted: [], removed: [] };
  }
  const toplevel = await canonical(capture.toplevel);
  const preserve = new Set(
    await Promise.all(
      preservePaths.map(async (path) =>
        toPosix(relative(toplevel, await canonical(resolve(root, path)))),
      ),
    ),
  );
  try {
    // Tracked drift is worktree-vs-snapshot content difference, not a status
    // comparison: a file dirty at capture and dirtied further by the agent
    // has an identical status entry and would slip through.
    const trackedDrift = (await git(toplevel, ["diff", "--name-only", "-z", capture.source]))
      .split("\0")
      .filter((path) => path !== "" && !preserve.has(path));
    const current = parseStatus(await git(toplevel, ["status", "--porcelain", "-z"]));
    const removed: string[] = [];
    for (const { code, path } of current) {
      if (code !== "??" || capture.untracked!.has(path) || preserve.has(path)) continue;
      await rm(join(toplevel, path), { force: true, recursive: true });
      removed.push(path);
    }
    if (trackedDrift.length > 0) {
      await git(toplevel, [
        "restore",
        "--source",
        capture.source,
        "--worktree",
        "--",
        ...trackedDrift,
      ]);
    }
    return { restored: true, drifted: trackedDrift, removed };
  } catch {
    return { restored: false, drifted: [], removed: [] };
  }
}
