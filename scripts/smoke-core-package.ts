import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const core = resolve(root, "packages/core");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "wfgraph-core-pack-"));

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

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        import { wfSqlite } from "@wfgraph/core/sqlite";

        const filename = "./smoke.sqlite";
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
  console.log("Packed @wfgraph/core SQLite entry opened and migrated");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
