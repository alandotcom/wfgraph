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

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every workspace that publishes, and the build that produces its output. */
const PUBLISHED = [
  { name: "@rova/core", dir: "packages/core", build: "build:lib" },
  { name: "@rova/plugins", dir: "packages/plugins", build: "build:plugins" },
];

// `from "x"`, `import "x"`, and `import("x")`, skipping relative specifiers.
// No whitespace in the specifier: a plugin's help text ends "...Bot Token from ",
// which is otherwise indistinguishable from an import.
const IMPORT_RE = /(?:from|import)\s*\(?\s*"([^".\s][^"\s]*)"/g;

/** "@scope/pkg/sub" and "pkg/sub" both belong to the package before the sub-path. */
function toPackageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

async function readDeclaredDependencies(
  packageDir: string
): Promise<Set<string>> {
  const manifest = JSON.parse(
    await readFile(join(workspaceRoot, packageDir, "package.json"), "utf-8")
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  // A peer counts: the adopter installs it.
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/**
 * Build before reading, every time.
 *
 * The check list runs `bun test` before `bun run build`, so a clean clone has no
 * dist at all, and a tree that does have one may have it from before the change
 * under test. Reading whichever bundle happens to be lying around would report
 * on yesterday's code and pass. The library build takes well under a second.
 */
const built = new Map<string, Promise<string[]>>();

function listBundles(dir: string, build: string): Promise<string[]> {
  const existing = built.get(dir);
  if (existing) {
    return existing;
  }

  const pending = (async () => {
    await $`bun run ${build}`.cwd(workspaceRoot).quiet();
    const entries = await readdir(join(workspaceRoot, dir, "dist"));
    return entries.filter((entry) => entry.endsWith(".js"));
  })();
  built.set(dir, pending);
  return pending;
}

async function readBundledImports(
  dir: string,
  build: string
): Promise<Set<string>> {
  const bundles = await listBundles(dir, build);
  const imported = new Set<string>();

  for (const bundle of bundles) {
    const source = await readFile(
      join(workspaceRoot, dir, "dist", bundle),
      "utf-8"
    );
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

describe.each(PUBLISHED)("the published $name bundle", ({ dir, build }) => {
  it("imports nothing it does not declare as a dependency", async () => {
    const [declared, imported] = await Promise.all([
      readDeclaredDependencies(dir),
      readBundledImports(dir, build),
    ]);

    // An empty dist means the build did not run; asserting over nothing would
    // pass and prove nothing.
    expect(imported.size).toBeGreaterThan(0);

    const undeclared = [...imported]
      .filter((name) => name !== "bun" && !declared.has(name))
      .sort();

    expect(undeclared).toEqual([]);
  });
});

describe("the published @rova/core bundle", () => {
  it("carries no vendor integration SDK", async () => {
    const imported = await readBundledImports("packages/core", "build:lib");

    expect(imported.size).toBeGreaterThan(0);

    // These belong to @rova/plugins, which an adopter installs separately. Their
    // presence here means something in packages/core reached across the package
    // boundary again.
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
