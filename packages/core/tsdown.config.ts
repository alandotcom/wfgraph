import { defineConfig } from "tsdown";

// Builds the publishable @rova/core library: `src/index.ts` is the small
// createAction/createTrigger surface, `src/app.ts` is the mountable fetch
// handler, `src/node.ts` translates that handler for hosts on node:http, and
// `src/plugin.ts` is what a package of integrations builds against. All four are
// named in the "exports" map in package.json, so the emitted file names here
// have to keep matching that map.
export default defineConfig({
  entry: ["src/index.ts", "src/app.ts", "src/node.ts", "src/plugin.ts"],
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
