import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The serving-side tests use a stand-in directory, so nothing else would notice
 * the real build moving or losing the tag the server rewrites.
 *
 * Imports the built module, not the source: `clientBundle.dir` resolves from
 * `import.meta.url` and only means anything from `dist/`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let bundleDir: string;

// The test run happens before `pnpm run build`, so build rather than report on
// whatever is on disk. Two full builds is the reason for the generous timeout:
// Vite's is a few seconds once its dependency cache is warm and considerably
// longer on the first run in a clean checkout, which is what CI does.
beforeAll(async () => {
  await run("pnpm", ["run", "build:client"], { cwd: repoRoot });
  await run("pnpm", ["exec", "tsdown"], {
    cwd: join(repoRoot, "packages/client"),
  });

  // A file:// URL, because the import specifier is an absolute path and the
  // module runner only accepts that scheme for one.
  const built = (await import(
    pathToFileURL(join(repoRoot, "packages/client/dist/index.js")).href
  )) as { clientBundle: { dir: string } };
  bundleDir = built.clientBundle.dir;
}, 180_000);

describe("clientBundle", () => {
  it("points at a directory holding the built entrypoint", async () => {
    const entries = await readdir(bundleDir);

    expect(entries).toContain("index.html");
    expect(entries.some((entry) => entry.endsWith(".js"))).toBe(true);
  });

  // The server rewrites this tag to tell the browser where Rova is mounted; a
  // bundle without one answers 503 on every page.
  it("ships an entrypoint carrying a base tag the server can rewrite", async () => {
    const html = await readFile(join(bundleDir, "index.html"), "utf-8");

    expect(html).toMatch(/<base\b[^>]*href="\/"/);
  });

  it("references its assets relatively, so the base tag governs them", async () => {
    const html = await readFile(join(bundleDir, "index.html"), "utf-8");
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1]
    );
    const assets = references.filter((href) => href !== "/");

    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.startsWith("./")).toBe(true);
    }
  });
});
