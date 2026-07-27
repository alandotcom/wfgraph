import { beforeAll, describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

/**
 * The serving-side tests use a stand-in directory, so nothing else would notice
 * the real build moving or losing the tag the server rewrites.
 *
 * Imports the built module, not the source: `clientBundle.dir` resolves from
 * `import.meta.url` and only means anything from `dist/`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let bundleDir: string;

beforeAll(async () => {
  // `bun test` runs before `bun run build`, so build rather than report on
  // whatever is on disk.
  await $`bun run build:client`.cwd(repoRoot).quiet();
  await $`bun x tsdown`.cwd(join(repoRoot, "packages/client")).quiet();

  const built = (await import(
    join(repoRoot, "packages/client/dist/index.js")
  )) as { clientBundle: { dir: string } };
  bundleDir = built.clientBundle.dir;
});

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
