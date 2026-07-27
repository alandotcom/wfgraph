import { beforeAll, describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

/**
 * What `@rova/client` promises `@rova/core` is a directory it can serve. The
 * tests on the serving side use a stand-in directory, which cannot notice the
 * real build moving, renaming, or losing the one tag the SPA needs, so this
 * checks the real output.
 *
 * It imports the built module rather than the source: `clientBundle.dir` is
 * resolved from `import.meta.url`, so it only means anything from `dist/`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let bundleDir: string;

beforeAll(async () => {
  // The check list runs `bun test` before `bun run build`, so build first rather
  // than reporting on whatever happens to be on disk.
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

  // The server rewrites this tag to tell the browser where Rova is mounted. A
  // bundle without one answers 503 on every page, so the shape of the tag is
  // part of the contract between the two packages.
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
