import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything the published bundle imports has to be something an adopter's
 * install actually provides.
 *
 * This repo is a workspace, so an undeclared dependency resolves here through
 * whatever another package hoisted into the tree and nothing complains. It found
 * `axios`: `@rova/core` imported it at runtime, no package.json named it, and it
 * worked only because Twilio pulled it in through `@rova/plugins`. An outside
 * adopter got `Cannot find module 'axios'` the first time a Twilio step ran.
 *
 * Reading the built output rather than the sources is the point. What matters is
 * what survived bundling, and that is the only place an inlined transitive
 * import shows up.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");

// `from "x"`, `import "x"`, and `import("x")`, skipping relative specifiers.
const IMPORT_RE = /(?:from|import)\s*\(?\s*"([^".][^"]*)"/g;

/** "@scope/pkg/sub" and "pkg/sub" both belong to the package before the sub-path. */
function toPackageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

async function readDeclaredDependencies(): Promise<Set<string>> {
  const manifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf-8")
  ) as { dependencies?: Record<string, string> };

  return new Set(Object.keys(manifest.dependencies ?? {}));
}

/**
 * Build before reading, every time.
 *
 * The check list runs `bun test` before `bun run build`, so a clean clone has no
 * dist at all, and a tree that does have one may have it from before the change
 * under test. Reading whichever bundle happens to be lying around would report
 * on yesterday's code and pass. The library build takes well under a second.
 */
let bundlesPromise: Promise<string[]> | undefined;

function listBundles(): Promise<string[]> {
  bundlesPromise ??= (async () => {
    await $`bun run build:lib`.cwd(join(packageDir, "../..")).quiet();
    const entries = await readdir(distDir);
    return entries.filter((entry) => entry.endsWith(".js"));
  })();

  return bundlesPromise;
}

async function readBundledImports(): Promise<Set<string>> {
  const bundles = await listBundles();
  const imported = new Set<string>();

  for (const bundle of bundles) {
    const source = await readFile(join(distDir, bundle), "utf-8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      // Node built-ins are always there; "bun:" only appears in code that only
      // runs under Bun, which provides it.
      if (
        !specifier ||
        specifier.startsWith("node:") ||
        specifier.startsWith("bun:")
      ) {
        continue;
      }
      imported.add(toPackageName(specifier));
    }
  }

  return imported;
}

describe("the published @rova/core bundle", () => {
  it("imports nothing it does not declare as a dependency", async () => {
    const [declared, imported] = await Promise.all([
      readDeclaredDependencies(),
      readBundledImports(),
    ]);

    // An empty dist means the build has not run; asserting over nothing would
    // pass and prove nothing.
    expect(imported.size).toBeGreaterThan(0);

    const undeclared = [...imported]
      .filter((name) => name !== "bun" && !declared.has(name))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it("carries no vendor integration SDK", async () => {
    const imported = await readBundledImports();

    // These belong to @rova/plugins, which an adopter installs separately. Their
    // presence here means something in packages/core reached across the package
    // boundary again.
    expect(imported.size).toBeGreaterThan(0);

    for (const sdk of [
      "twilio",
      "resend",
      "@slack/web-api",
      "@linear/sdk",
      "@clerk/backend",
      "@fountain-bio/acuity",
      // Twilio's transitive HTTP client, and the specific import that used to
      // resolve here only because the workspace hoisted it.
      "axios",
    ]) {
      expect([...imported]).not.toContain(sdk);
    }
  });
});
