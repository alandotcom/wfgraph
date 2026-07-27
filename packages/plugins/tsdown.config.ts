import { defineConfig } from "tsdown";

// The three names in this package's "exports" map. They stay separate so a
// server can import metadata and step registrations without pulling React in.
//
// @rova/shared is private and gets inlined, as it is into @rova/core. The
// registries it carries agree across both bundles through Symbol.for.
export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/ui.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  clean: true,
});
