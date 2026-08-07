import { defineConfig } from "tsdown";

// The two names in this package's "exports" map. They stay separate because the
// integrations are server-only values and the icons are React components: a server
// imports the first without pulling React in, and the browser imports the second
// without pulling a vendor client in.
//
// @wfgraph/shared is private and gets inlined, as it is into @wfgraph/core.
export default defineConfig({
  entry: ["src/index.ts", "src/ui.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  clean: true,
});
