import { defineConfig } from "bunup";

export default defineConfig({
  entry: ["src/index.ts", "src/hono.ts"],
  format: "esm",
  target: "node",
  outDir: "dist",
  sourcemap: "none",
  dts: { inferTypes: true },
  splitting: true,
  external: ["bun"],
  loader: { ".html": "text" },
});
