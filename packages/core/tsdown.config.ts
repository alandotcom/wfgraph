import { defineConfig } from "tsdown";

// Builds the publishable @rova/core library: `src/index.ts` is the small
// createAction/createTrigger surface, `src/hono.ts` is the mountable server app.
// Both are named in the "exports" map in package.json, so the emitted file names
// here have to keep matching that map.
export default defineConfig({
  entry: ["src/index.ts", "src/hono.ts"],
  format: "esm",
  // tsdown calls this "platform" where bunup called it "target". It selects
  // Node-flavoured resolution and externalization, which is what a server
  // library needs. tsdown's own default is already "node"; stated here so the
  // intent survives a future default change.
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
  // "bun" is a runtime-provided module, so it must stay an import rather than
  // being pulled into the bundle.
  deps: { neverBundle: ["bun"] },
  // Wipe dist between builds so a renamed entry cannot leave a stale hashed
  // chunk behind. The client SPA also writes into dist/client, which is why the
  // root "build" script runs build:lib before build:client.
  clean: true,
});
