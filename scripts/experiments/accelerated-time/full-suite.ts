import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

/** Package the existing tests without changing their assertions or deadlines. */
export async function prepareFullSuite(work: string) {
  const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
  const core = resolve(work, "packages/core");
  await mkdir(core, { recursive: true });
  await writeFile(
    resolve(work, "package.json"),
    JSON.stringify({
      name: "wfgraph-clock-suite",
      private: true,
      type: "module",
      packageManager: rootManifest.packageManager,
      dependencies: {
        vitest: require("vitest/package.json").version,
        vite: require("vite/package.json").version,
      },
    })
  );
  // Migration discovery walks upward to the package owning the bundled code.
  await writeFile(
    resolve(core, "package.json"),
    JSON.stringify({ name: "@wfgraph/core", type: "module" })
  );
  await cp("packages/core/drizzle", resolve(core, "drizzle"), {
    recursive: true,
  });
  await cp("packages/core/drizzle-sqlite", resolve(core, "drizzle-sqlite"), {
    recursive: true,
  });
  await mkdir(resolve(work, "scripts/plugins"), { recursive: true });
  await cp(
    "scripts/plugins/workspace-source-aliases.ts",
    resolve(work, "scripts/plugins/workspace-source-aliases.ts")
  );
  await cp(
    "vitest.reliability.config.ts",
    resolve(work, "vitest.reliability.config.ts")
  );
  await cp("pnpm-lock.yaml", resolve(work, "pnpm-lock.yaml"));
  await build({
    entryPoints: ["admission", "cancel", "exit"].map(
      (family) =>
        `packages/core/src/backend/testing/reliability/${family}.reliability.test.ts`
    ),
    outbase: ".",
    outdir: work,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["vitest"],
    banner: {
      js: 'import { createRequire as clockCreateRequire } from "node:module"; const require = clockCreateRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: ["scripts/experiments/accelerated-time/guest-suite.ts"],
    outfile: resolve(work, "probe.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  await writeFile(
    resolve(work, "guest.env"),
    [
      "WFGRAPH_RELIABILITY_RUNS=5",
      "WFGRAPH_RELIABILITY_SEED=424242",
      "WFGRAPH_RELIABILITY_BACKEND=all",
      `WFGRAPH_RELIABILITY_REVISION=${revision}`,
      "",
    ].join("\n")
  );
  // Install the Linux toolchain before measuring VM launch. Application dependencies
  // are already bundled from this checkout; only Vitest and Vite stay external.
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/arm64",
      "--mount",
      `type=bind,src=${work},dst=/work`,
      "--workdir",
      "/work",
      "node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a",
      "sh",
      "-ec",
      'mkdir /tmp/pnpm; version=$(node -p \'require("./package.json").packageManager.split("@")[1]\'); wget -qO- "https://registry.npmjs.org/pnpm/-/pnpm-$version.tgz" | tar xz -C /tmp/pnpm; node /tmp/pnpm/package/bin/pnpm.cjs install --ignore-scripts --no-frozen-lockfile; mkdir -p node_modules/.bin; ln -s /usr/local/bin/inngest node_modules/.bin/inngest',
    ],
    { stdio: "inherit" }
  );
  // Native-import the prepared bundles, avoiding a second Vite transform of all
  // application dependencies. Vitest still discovers the original three paths.
  const nativePackage = resolve(work, "node_modules/@wfgraph-clock/suite");
  await mkdir(resolve(work, "node_modules/@wfgraph-clock"), {
    recursive: true,
  });
  await rename(core, nativePackage);
  const testDirectory = resolve(core, "src/backend/testing/reliability");
  await mkdir(testDirectory, { recursive: true });
  await Promise.all(
    ["admission", "cancel", "exit"].map((family) =>
      writeFile(
        resolve(testDirectory, `${family}.reliability.test.ts`),
        `import "@wfgraph-clock/suite/src/backend/testing/reliability/${family}.reliability.test.mjs";\n`
      )
    )
  );
}
