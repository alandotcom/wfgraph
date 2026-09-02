import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const core = resolve(root, "packages/core");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "wfgraph-core-pack-"));

function openAndVerifySqlite(importPath: string, filename: string): void {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        const { wfSqlite } = await import(${JSON.stringify(importPath)});

        const filename = ${JSON.stringify(filename)};
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
        if (journal?.total !== 1) {
          throw new Error("The packed SQLite baseline migration did not run");
        }
      `,
    ],
    { cwd: temporaryDirectory, stdio: "inherit" }
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

  openAndVerifySqlite("@wfgraph/core/sqlite", "./smoke.sqlite");

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
  openAndVerifySqlite(bundledEntry, "./bundled-smoke.sqlite");

  console.log("Packed and bundled @wfgraph/core SQLite entries migrated");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
