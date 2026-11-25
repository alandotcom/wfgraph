import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import coreManifest from "../../packages/core/package.json" with { type: "json" };
import pluginsManifest from "../../packages/plugins/package.json" with { type: "json" };

/**
 * Bundles entries from source the way wrangler bundles a Worker and reads
 * esbuild's metafile. Every integration export of `@wfgraph/plugins` must have
 * a row in `ADDED_KIB_CEILING`. Each integration entry must stay under that
 * ceiling and must not reach an `import()` of bundled code, and neither may the
 * Worker host entry of `@wfgraph/core`. Each entry of `@wfgraph/core` must
 * bundle no module of a package in `ENTRY_ONLY_PACKAGES` unless the package's
 * row names that entry among its owners.
 */

/**
 * The most bytes, in KiB, that each integration may add to a Worker bundle on
 * top of `@wfgraph/core/plugin`. A new integration takes one row here. Each
 * ceiling sits about 25 percent over the size measured when it was set, so a
 * new vendor dependency or a large new module fails the test while ordinary
 * growth of the integration's own code does not.
 */
const ADDED_KIB_CEILING: Record<string, number> = {
  clerk: 21,
  linear: 19,
  posthog: 36,
  resend: 92,
  slack: 21,
  twilio: 15,
};

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_BASELINE_ENTRY = "packages/core/src/plugin.ts";
const WORKER_HOST_ENTRY = "packages/core/src/worker.ts";

/**
 * Packages that only some entries of `@wfgraph/core` may bundle, each with the
 * subpaths of those entries in core's "exports" map: the four Effect model
 * provider packages, the MCP server SDK, and `zod`, which arrives through the
 * packages `via` names. A name matches the package of that name, and a scope
 * such as `@modelcontextprotocol` matches every package in the scope.
 */
const ENTRY_ONLY_PACKAGES: readonly {
  readonly name: string;
  readonly owners: readonly string[];
  readonly via?: string;
}[] = [
  { name: "@effect/ai-openai", owners: ["./openai"] },
  { name: "@effect/ai-anthropic", owners: ["./anthropic"] },
  { name: "@effect/ai-openrouter", owners: ["./openrouter"] },
  { name: "@effect/ai-openai-compat", owners: ["./openai-compatible"] },
  { name: "@modelcontextprotocol", owners: ["./mcp"] },
  // The optional `inngest` peer depends on zod too, and `./inngest` is the one
  // entry that imports it.
  {
    name: "zod",
    owners: ["./mcp", "./inngest"],
    via: "@modelcontextprotocol/server and inngest",
  },
];

const CORE_SUBPATHS = Object.keys(coreManifest.exports);

/** The package specifier of a subpath of core's "exports" map. */
function coreSpecifier(subpath: string): string {
  return subpath === "."
    ? "@wfgraph/core"
    : `@wfgraph/core/${subpath.slice(2)}`;
}

/** The source file tsdown builds a subpath of core's "exports" map from. */
function coreSource(subpath: string): string {
  return `packages/core/src/${subpath === "." ? "index" : subpath.slice(2)}.ts`;
}

/** Why a package may not reach another entry's bundle, for a failure message. */
function ownership(row: (typeof ENTRY_ONLY_PACKAGES)[number]): string {
  const owners = row.owners.map(coreSpecifier).join(" and ");
  return row.via === undefined
    ? `only ${owners} may import it`
    : `${row.name} arrives through ${row.via}, which only ${owners} import, and no other entry of @wfgraph/core should bundle it`;
}

/** Whether a bundle input path lies inside the package or scope `name`. */
function isInputOf(name: string, path: string): boolean {
  return path.includes(`/node_modules/${name}/`);
}

/** Whether a bundle input path lies inside any entry-only package. */
function isEntryOnlyInput(path: string): boolean {
  return ENTRY_ONLY_PACKAGES.some(({ name }) => isInputOf(name, path));
}

/**
 * Each bundle input from the package or scope `name`, with the inputs that
 * import it from outside every entry-only package, which is where the chain
 * starts.
 */
function inputsOf(name: string, metafile: Metafile): string[] {
  return Object.keys(metafile.inputs)
    .filter((path) => isInputOf(name, path))
    .map((path) => {
      const importers = Object.entries(metafile.inputs)
        .filter(
          ([importer, input]) =>
            !isEntryOnlyInput(importer) &&
            input.imports.some((imported) => imported.path === path)
        )
        .map(([importer]) => importer);
      return importers.length === 0
        ? path
        : `${path} imported by ${importers.join(", ")}`;
    });
}

function integrationEntry(name: string): string {
  return `packages/plugins/src/${name}/index.ts`;
}

/** Each entry's metafile, so a test reading an entry another test bundled reuses it. */
const bundles = new Map<string, Promise<Metafile>>();

/**
 * Bundles one entry into one ESM file with the settings wrangler uses for a
 * Worker, and answers the metafile. Paths in the metafile are relative to the
 * repository root. The root tsconfig's `paths` point `@wfgraph/core/*` at
 * core's source, so the bundle measures the code in this checkout rather than
 * whatever `packages/core/dist` holds.
 */
async function bundleForWorker(entry: string): Promise<Metafile> {
  const cached = bundles.get(entry);
  if (cached !== undefined) {
    return await cached;
  }
  const bundle = bundleOnce(entry);
  bundles.set(entry, bundle);
  return await bundle;
}

async function bundleOnce(entry: string): Promise<Metafile> {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: [...builtinModules, "node:*", "cloudflare:*"],
    tsconfig: "tsconfig.json",
    outfile: "worker.js",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return result.metafile;
}

/**
 * Each `import()` in the bundle whose target esbuild bundled. esbuild wraps
 * that target, and every module it imports statically, in a lazy initializer,
 * which costs startup time and stops tree-shaking of those modules. An
 * `import()` of an external module leaves the bundle untouched and is allowed.
 */
function dynamicImportsOfBundledCode(metafile: Metafile): string[] {
  return Object.entries(metafile.inputs).flatMap(([importer, input]) =>
    input.imports
      .filter(
        (imported) =>
          imported.kind === "dynamic-import" && imported.external !== true
      )
      .map((imported) => `${importer} calls import() on ${imported.path}`)
  );
}

/** The inputs of the single output file, with the bytes each wrote into it. */
function outputInputs(
  metafile: Metafile
): { path: string; bytesInOutput: number }[] {
  return Object.values(metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs).map(([path, { bytesInOutput }]) => ({
      path,
      bytesInOutput,
    }))
  );
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

describe("Worker bundles", () => {
  let baselineInputs: ReadonlySet<string>;

  beforeAll(async () => {
    const baseline = await bundleForWorker(PLUGIN_BASELINE_ENTRY);
    baselineInputs = new Set(outputInputs(baseline).map(({ path }) => path));
  });

  it("budgets every integration entry the plugins package exports", () => {
    // `./ui` is the browser half of the package and never reaches a Worker.
    const exportedIntegrations = Object.keys(pluginsManifest.exports)
      .filter((subpath) => subpath !== "./ui")
      .map((subpath) => subpath.replace(/^\.\//, ""));
    expect(
      exportedIntegrations.toSorted(),
      "Each integration export in packages/plugins/package.json needs a row in ADDED_KIB_CEILING, and each row needs an export"
    ).toEqual(Object.keys(ADDED_KIB_CEILING).toSorted());
  });

  it.each(Object.entries(ADDED_KIB_CEILING))(
    "%s stays under its ceiling and loads nothing through import()",
    async (name, ceilingKib) => {
      const metafile = await bundleForWorker(integrationEntry(name));

      expect(
        dynamicImportsOfBundledCode(metafile),
        `${integrationEntry(name)} reaches an import() of bundled code; import it statically`
      ).toEqual([]);

      const added = outputInputs(metafile)
        .filter(({ path }) => !baselineInputs.has(path))
        .toSorted((a, b) => b.bytesInOutput - a.bytesInOutput);
      const addedBytes = added.reduce(
        (total, { bytesInOutput }) => total + bytesInOutput,
        0
      );
      const largest = added
        .slice(0, 5)
        .map(({ path, bytesInOutput }) => `  ${kib(bytesInOutput)}  ${path}`)
        .join("\n");
      expect(
        addedBytes,
        `${name} adds ${kib(addedBytes)} to a Worker bundle over @wfgraph/core/plugin, and its ceiling in ADDED_KIB_CEILING is ${ceilingKib} KiB. Largest added inputs:\n${largest}\n`
      ).toBeLessThanOrEqual(ceilingKib * 1024);
    }
  );

  it("the Worker host entry loads nothing through import()", async () => {
    const metafile = await bundleForWorker(WORKER_HOST_ENTRY);
    expect(
      dynamicImportsOfBundledCode(metafile),
      `${WORKER_HOST_ENTRY} reaches an import() of bundled code; import it statically`
    ).toEqual([]);
  });

  it("names entries of @wfgraph/core as the owners of each entry-only package", () => {
    for (const { name, owners } of ENTRY_ONLY_PACKAGES) {
      for (const owner of owners) {
        expect
          .soft(
            CORE_SUBPATHS,
            `${name} names ${owner}, which packages/core/package.json does not export`
          )
          .toContain(owner);
      }
    }
  });

  it.each(
    CORE_SUBPATHS.map((subpath) => [coreSpecifier(subpath), subpath] as const)
  )(
    "%s bundles no package that belongs to another entry",
    async (_specifier, subpath) => {
      const source = coreSource(subpath);
      const metafile = await bundleForWorker(source);
      for (const row of ENTRY_ONLY_PACKAGES) {
        if (row.owners.includes(subpath)) {
          continue;
        }
        expect
          .soft(
            inputsOf(row.name, metafile),
            `${source} bundles ${row.name}; ${ownership(row)}`
          )
          .toEqual([]);
      }
    }
  );
});
