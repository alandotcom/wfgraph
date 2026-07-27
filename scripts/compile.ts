import { mkdir, rename, rm } from "node:fs/promises";

const outputPath = "./dist/server";
const fallbackOutputPath = "./server";
const legacyOutputPath = "./dist/notifications-server";

function isArchitecture(value: string): value is Bun.Build.Architecture {
  return value === "x64" || value === "arm64";
}

function isLibc(value: string): value is Bun.Build.Libc {
  return value === "glibc" || value === "musl";
}

function isSimd(value: string): value is Bun.Build.SIMD {
  return value === "baseline" || value === "modern";
}

function isCompileTarget(value: string): value is Bun.Build.CompileTarget {
  const segments = value.split("-");
  if (segments[0] !== "bun") {
    return false;
  }

  const platform = segments[1];
  const architecture = segments[2];
  if (!(platform && architecture && isArchitecture(architecture))) {
    return false;
  }

  if (segments.length === 3) {
    return (
      platform === "darwin" || platform === "linux" || platform === "windows"
    );
  }

  const fourthSegment = segments[3];
  if (!fourthSegment) {
    return false;
  }

  if (platform === "darwin") {
    return segments.length === 4 && isSimd(fourthSegment);
  }

  if (platform === "windows") {
    return (
      architecture === "x64" && segments.length === 4 && isSimd(fourthSegment)
    );
  }

  if (platform !== "linux") {
    return false;
  }

  if (segments.length === 4) {
    return isLibc(fourthSegment) || isSimd(fourthSegment);
  }

  if (segments.length === 5) {
    const fifthSegment = segments[4];
    return !!fifthSegment && isSimd(fourthSegment) && isLibc(fifthSegment);
  }

  return false;
}

function resolveCompileTarget(
  value: string | undefined
): Bun.Build.CompileTarget | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return isCompileTarget(normalized) ? normalized : undefined;
}

const compileTarget = resolveCompileTarget(Bun.env.BUN_COMPILE_TARGET);

const result = await Bun.build({
  entrypoints: ["./server.ts"],
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
