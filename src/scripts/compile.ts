import { mkdir, rename, rm } from "node:fs/promises";

const outputPath = "./dist/server";
const fallbackOutputPath = "./server";
const legacyOutputPath = "./dist/notifications-server";

const compileTarget = Bun.env.BUN_COMPILE_TARGET as
  | Bun.Build.CompileTarget
  | undefined;

const result = await Bun.build({
  entrypoints: ["./src/server.ts"],
  target: "bun",
  minify: true,
  publicPath: "/",
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunk-[name].[ext]",
    asset: "asset-[name].[ext]",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.DEV": "false",
  },
  compile: compileTarget ?? true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

if (await Bun.file(fallbackOutputPath).exists()) {
  await mkdir("./dist", { recursive: true });
  if (await Bun.file(outputPath).exists()) {
    await rm(outputPath, { force: true });
  }
  await rename(fallbackOutputPath, outputPath);
}

if (await Bun.file(legacyOutputPath).exists()) {
  await rm(legacyOutputPath, { force: true });
}
