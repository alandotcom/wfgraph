import { defineConfig } from "tsdown";

// Only src/index.ts. The SPA itself is built by Vite, driven by the repo root's
// vite.config.ts through `pnpm run build:client`, into dist/client beside this
// output, which is what `clientBundle.dir` resolves to.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  // "!" is an exclusion, so cleaning cannot take out the SPA build's output.
  clean: ["dist/*", "!dist/client"],
});
