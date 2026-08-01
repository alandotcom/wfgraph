import { defineConfig } from "tsdown";

// Builds the publishable @rova/core library: `src/index.ts` is the one
// host-facing entry, re-exporting the authoring vocabulary, `createRovaApp`
// and `createRequestListener` from the internal `app.ts` and `node.ts`
// modules; `src/plugin.ts` is what a package of integrations builds against,
// `src/testing.ts` is what that package's own suite drives an action with, and
// `src/migrate.ts` applies the migrations without building an app. Every entry
// here is named in the "exports" map in package.json, so the emitted file names
// have to keep matching that map.
export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/testing.ts", "src/migrate.ts"],
  format: "esm",
  // Selects Node-flavoured resolution and externalization, which is what a
  // server library needs. tsdown's own default is already "node"; stated here
  // so the intent survives a future default change.
  platform: "node",
  outDir: "dist",
  // With platform "node" tsdown would default to fixed .mjs/.d.mts extensions.
  // This package is "type": "module", so plain .js is already ESM, and the
  // "exports" map in package.json names dist/index.js and dist/index.d.ts.
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  // Module and path resolution for the bundle and the .d.ts pass. This lives at
  // the repo root on purpose; see the comment at the top of that file for why the
  // declaration emitter needs a root that spans all three workspace packages.
  tsconfig: "../../tsconfig.build.json",
  // Wipe the output between builds so a renamed entry cannot leave a stale
  // hashed chunk behind. Nothing else writes into this dist: the SPA is
  // @rova/client's output now.
  clean: true,
});
