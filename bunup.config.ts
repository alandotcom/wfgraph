import { defineConfig } from "bunup";

export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  target: "bun",
  outDir: "dist/lib",
  sourcemap: "none",
  dts: {
    inferTypes: true,
  },
  splitting: false,
  external: ["bun"],
  loader: {
    ".html": "text",
  },
});
