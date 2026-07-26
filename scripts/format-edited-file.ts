/**
 * Formats a single file with oxfmt. Wired to the `afterFileEdit` hook in
 * .cursor/hooks.json so a file the agent just edited gets formatted on its own,
 * leaving the rest of the tree untouched.
 *
 * Cursor sends the hook a JSON payload on stdin shaped
 * `{ file_path, edits }`. Only `file_path` is needed here; it is an absolute
 * path to the file that changed.
 */
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const oxfmt = resolve(repoRoot, "node_modules/.bin/oxfmt");

async function readEditedFilePath(): Promise<string | undefined> {
  try {
    const payload: unknown = await Bun.stdin.json();
    if (payload && typeof payload === "object" && "file_path" in payload) {
      const { file_path: filePath } = payload;
      if (typeof filePath === "string" && filePath.length > 0) {
        return filePath;
      }
    }
  } catch {
    // Fall through to the warning below: unreadable stdin and a payload missing
    // the path both mean the same thing here.
  }
}

const filePath = await readEditedFilePath();

// A payload this script cannot read is the hook's problem, and the edit itself
// was fine. Say so and exit clean so a bad payload never blocks an edit.
if (!filePath) {
  console.warn(
    "afterFileEdit payload carried no usable file_path; skipping format"
  );
  process.exit(0);
}

// `--no-error-on-unmatched-pattern` covers the file types oxfmt leaves alone,
// such as this repo's .sh and .sql files. oxfmt exits 2 on those otherwise, and
// the hook would report a failure for an edit that needed no formatting.
const result = Bun.spawnSync({
  cmd: [oxfmt, "--no-error-on-unmatched-pattern", filePath],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(result.exitCode ?? 0);
