import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import pluginsManifest from "../../packages/plugins/package.json" with { type: "json" };

/**
 * Holds every integration entry of `@wfgraph/plugins`, and the Worker host
 * entry of `@wfgraph/core`, to what a Cloudflare Worker pays for it at startup.
 * Each entry is bundled from source the way wrangler bundles a Worker, and the
 * assertions read esbuild's metafile, so they measure bytes and import kinds.
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

function integrationEntry(name: string): string {
  return `packages/plugins/src/${name}/index.ts`;
}

/**
 * Bundles one entry into one ESM file with the settings wrangler uses for a
 * Worker, and answers the metafile. Paths in the metafile are relative to the
 * repository root. The root tsconfig's `paths` point `@wfgraph/core/*` at
 * core's source, so the bundle measures the code in this checkout rather than
 * whatever `packages/core/dist` holds.
 */
async function bundleForWorker(entry: string): Promise<Metafile> {
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
});
