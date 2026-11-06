import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const core = resolve(root, "packages/core");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "wfgraph-core-pack-"));

function openAndVerifySqlite(
  importPath: string,
  filename: string,
  expectedMigrationCount: number
): void {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        const { wfSqlite } = await import(${JSON.stringify(importPath)});

        const filename = ${JSON.stringify(filename)};
        const expectedMigrationCount = ${expectedMigrationCount};
        const persistence = await wfSqlite({ filename }).open({
          seal: JSON.stringify,
          open: () => { throw new Error("unused"); },
        });
        await persistence.close();

        const database = new DatabaseSync(filename, { readOnly: true });
        const journal = database.prepare(
          "select count(*) as total from __wfgraph_sqlite_migrations"
        ).get();
        database.close();
        if (journal?.total !== expectedMigrationCount) {
          throw new Error(
            "The packed SQLite migration journal has " +
              (journal?.total ?? "unknown") +
              " entries; expected " +
              expectedMigrationCount
          );
        }
      `,
    ],
    { cwd: temporaryDirectory, stdio: "inherit" }
  );
}

/**
 * Imports each entry the packed manifest's `exports` map names, except
 * `./inngest`, in an install that holds no `inngest`. `inngest` is an optional
 * peer dependency, so a host that never installed it must still load every
 * other entry; an entry whose chunks reach the SDK fails here with
 * ERR_MODULE_NOT_FOUND.
 */
function importEveryEntryButInngest(): void {
  const manifest: unknown = JSON.parse(
    readFileSync(
      resolve(temporaryDirectory, "node_modules/@wfgraph/core/package.json"),
      "utf8"
    )
  );
  const exportsMap =
    typeof manifest === "object" && manifest !== null && "exports" in manifest
      ? manifest.exports
      : undefined;
  if (typeof exportsMap !== "object" || exportsMap === null) {
    throw new Error("The packed @wfgraph/core manifest has no exports map");
  }
  const specifiers = Object.keys(exportsMap)
    .filter((subpath) => subpath !== "./inngest")
    .map((subpath) => `@wfgraph/core${subpath.slice(1)}`);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        const inngest = await import("inngest").then(
          () => true,
          (error) => error.code !== "ERR_MODULE_NOT_FOUND"
        );
        if (inngest) {
          throw new Error("The smoke install resolves inngest, so it cannot show the entries load without it");
        }
        for (const specifier of ${JSON.stringify(specifiers)}) {
          await import(specifier);
        }
      `,
    ],
    { cwd: temporaryDirectory, stdio: "inherit" }
  );
  console.log(
    `Loaded ${specifiers.length} @wfgraph/core entries without inngest installed`
  );
}

try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporaryDirectory], {
    cwd: core,
    stdio: "inherit",
  });
  const tarball = readdirSync(temporaryDirectory).find((file) =>
    file.endsWith(".tgz")
  );
  if (tarball === undefined) {
    throw new Error("pnpm pack did not produce an @wfgraph/core tarball");
  }

  writeFileSync(
    resolve(temporaryDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@wfgraph/core": `file:${resolve(temporaryDirectory, tarball)}`,
      },
    })
  );
  writeFileSync(
    resolve(temporaryDirectory, "pnpm-workspace.yaml"),
    "allowBuilds:\n  msgpackr-extract: false\n  protobufjs: true\n"
  );
  execFileSync("pnpm", ["install"], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });

  importEveryEntryButInngest();

  const packagedSqliteMigrationCount = readdirSync(
    resolve(temporaryDirectory, "node_modules/@wfgraph/core/drizzle-sqlite"),
    { withFileTypes: true }
  ).filter((entry) => entry.isDirectory()).length;

  openAndVerifySqlite(
    "@wfgraph/core/sqlite",
    "./smoke.sqlite",
    packagedSqliteMigrationCount
  );

  const bundledEntry = resolve(temporaryDirectory, "sqlite-bundle.mjs");
  execFileSync(
    resolve(root, "node_modules/.bin/esbuild"),
    [
      "node_modules/@wfgraph/core/dist/sqlite.js",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${bundledEntry}`,
    ],
    { cwd: temporaryDirectory, stdio: "inherit" }
  );
  openAndVerifySqlite(
    bundledEntry,
    "./bundled-smoke.sqlite",
    packagedSqliteMigrationCount
  );

  console.log("Packed and bundled @wfgraph/core SQLite entries migrated");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
