import { type FSWatcher, watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";
import { createReactCompilerPlugin } from "./plugins/react-compiler-plugin";

const CLIENT_ENTRYPOINT = "./packages/core/client/index.html";
const CLIENT_OUTPUT_DIR = Bun.env.CLIENT_DIST_DIR ?? "./dist/client";
const WATCH_FLAG = "--watch";
const DEBOUNCE_MS = 120;

const isWatchMode = Bun.argv.includes(WATCH_FLAG);
const isProduction = Bun.env.NODE_ENV === "production";

let isBuilding = false;
let rebuildQueued = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function logInfo(message: string): void {
  console.log(`[client-build] ${message}`);
}

function logError(message: string): void {
  console.error(`[client-build] ${message}`);
}

async function buildClientBundle(): Promise<boolean> {
  await mkdir(CLIENT_OUTPUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRYPOINT],
    outdir: CLIENT_OUTPUT_DIR,
    target: "browser",
    splitting: true,
    publicPath: "./",
    sourcemap: isProduction ? "none" : "inline",
    minify: isProduction,
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        Bun.env.NODE_ENV ?? (isProduction ? "production" : "development")
      ),
      "import.meta.env.DEV": isProduction ? "false" : "true",
    },
    plugins: [createReactCompilerPlugin(), tailwindPlugin],
    throw: false,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    return false;
  }

  logInfo(`build completed (${result.outputs.length} outputs)`);
  return true;
}

async function queueBuild(): Promise<void> {
  if (isBuilding) {
    rebuildQueued = true;
    return;
  }

  isBuilding = true;

  const processQueuedBuilds = async (): Promise<void> => {
    rebuildQueued = false;
    const success = await buildClientBundle();
    if (!success) {
      logError("build failed; waiting for file changes");
    }
    if (rebuildQueued) {
      await processQueuedBuilds();
    }
  };

  try {
    await processQueuedBuilds();
  } finally {
    isBuilding = false;
  }
}

function scheduleRebuild(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    queueBuild().catch((error: unknown) => {
      logError(`unexpected build failure: ${String(error)}`);
    });
  }, DEBOUNCE_MS);
}

function shouldIgnoreWatchPath(filePath: string): boolean {
  return (
    filePath.includes("/node_modules/") ||
    filePath.includes("/.git/") ||
    filePath.includes("/dist/") ||
    filePath.includes("/.next/") ||
    filePath.includes("/.turbo/") ||
    filePath.includes("/tmp/")
  );
}

async function collectDirectories(rootDir: string): Promise<string[]> {
  const directories = [rootDir];
  const entries = await readdir(rootDir, { withFileTypes: true });

  const walkEntries = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (!entry) {
      return;
    }

    if (!entry.isDirectory()) {
      await walkEntries(index + 1);
      return;
    }

    const fullPath = path.join(rootDir, entry.name);
    const normalized = fullPath.split(path.sep).join("/");

    if (shouldIgnoreWatchPath(`/${normalized}/`)) {
      await walkEntries(index + 1);
      return;
    }

    directories.push(...(await collectDirectories(fullPath)));
    await walkEntries(index + 1);
  };

  await walkEntries(0);

  return directories;
}

function createWatcher(
  targetPath: string,
  recursive: boolean
): FSWatcher | null {
  try {
    return watch(
      targetPath,
      { recursive },
      (_eventType: string, filename: string | Buffer | null) => {
        if (!filename) {
          scheduleRebuild();
          return;
        }

        const changedPath = path.resolve(targetPath, filename.toString());
        const normalized = changedPath.split(path.sep).join("/");

        if (shouldIgnoreWatchPath(normalized)) {
          return;
        }

        scheduleRebuild();
      }
    );
  } catch {
    return null;
  }
}

async function setupWatchers(): Promise<FSWatcher[]> {
  const watchers: FSWatcher[] = [];

  const recursiveWatcher = createWatcher("./packages", true);
  if (recursiveWatcher) {
    watchers.push(recursiveWatcher);
    logInfo("watching ./packages recursively");
  } else {
    const directories = await collectDirectories("./packages");
    for (const directory of directories) {
      const watcher = createWatcher(directory, false);
      if (watcher) {
        watchers.push(watcher);
      }
    }
    logInfo(`watching ${watchers.length} source directories`);
  }

  return watchers;
}

function closeWatchers(watchers: FSWatcher[]): void {
  for (const watcher of watchers) {
    watcher.close();
  }
}

async function run(): Promise<void> {
  const initialSuccess = await buildClientBundle();

  if (!isWatchMode) {
    process.exit(initialSuccess ? 0 : 1);
  }

  const watchers = await setupWatchers();

  const cleanup = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    closeWatchers(watchers);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  if (!initialSuccess) {
    logError("initial build failed; watching for changes");
  }

  await new Promise(() => undefined);
}

await run();
