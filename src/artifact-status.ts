import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Return repository-relative artifacts hidden by .gitignore, when Git is available. */
export async function ignoredArtifacts(
  root: string,
  paths: readonly string[],
): Promise<string[]> {
  const ignored: string[] = [];
  for (const path of paths) {
    try {
      await execFileAsync("git", ["check-ignore", "--quiet", "--", path], {
        cwd: root,
        windowsHide: true,
      });
      ignored.push(path);
    } catch {
      // Not ignored, or Git is unavailable; neither should block a local run.
    }
  }
  return ignored;
}
