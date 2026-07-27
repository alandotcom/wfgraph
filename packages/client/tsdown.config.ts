import { defineConfig } from "tsdown";

// Only the tiny entry that tells a host where the built SPA sits. The SPA itself
// is built by scripts/build-client.ts with Bun's HTML bundler and lands in
// dist/client, beside this file's output, which is what `clientBundle.dir`
// resolves to at runtime.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  // dist/client is the other half of this package's output, written by
  // scripts/build-client.ts. tsdown hands these globs to tinyglobby, where a
  // leading "!" is an exclusion, so a blanket clean cannot delete it.
  clean: ["dist/*", "!dist/client"],
});
