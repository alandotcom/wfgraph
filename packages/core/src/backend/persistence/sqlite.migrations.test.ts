import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, ManagedRuntime } from "effect";
import { sql } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { openSqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { sqliteMigrations } from "#src/backend/persistence/sqlite/generated-migrations";
import { runSqliteMigrations } from "#src/backend/persistence/sqlite/migrations";

const directories: string[] = [];
const migrationsDir = resolve(import.meta.dirname, "../../../drizzle-sqlite");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function migrationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-migrations-"));
  directories.push(directory);
  const migrations = join(directory, "migrations");
  const baseline = join(migrations, "20260901000000_baseline");
  await mkdir(baseline, { recursive: true });
  await writeFile(
    join(baseline, "migration.sql"),
    `
      create table parents (id text primary key) strict;
      --> statement-breakpoint
      create table children (
        id text primary key,
        parent_id text not null references parents(id) on delete cascade
      ) strict;
      --> statement-breakpoint
      insert into parents values ('parent');
      --> statement-breakpoint
      insert into children values ('child', 'parent');
    `
  );
  return {
    filename: join(directory, "migration.db"),
    migrations,
  };
}

async function migrate(
  filename: string,
  migrations: string
): Promise<{ foreign_keys: number }> {
  await using runtime = ManagedRuntime.make(
    SqliteClient.layer({ filename, busyTimeout: 1_000 })
  );
  const database = await runtime.runPromise(makeWithDefaults());
  await runtime.runPromise(
    runSqliteMigrations(
      database,
      readMigrationFiles({ migrationsFolder: migrations })
    )
  );
  return await runtime.runPromise(
    database.get<{ foreign_keys: number }>(sql`pragma foreign_keys`)
  );
}

async function rejectedMigration(filename: string, migrations: string) {
  await using runtime = ManagedRuntime.make(
    SqliteClient.layer({ filename, busyTimeout: 1_000 })
  );
  const database = await runtime.runPromise(makeWithDefaults());
  const error = await runtime.runPromise(
    runSqliteMigrations(
      database,
      readMigrationFiles({ migrationsFolder: migrations })
    ).pipe(Effect.flip)
  );
  const pragmas = await runtime.runPromise(
    database.get<{ foreign_keys: number }>(sql`pragma foreign_keys`)
  );
  return { error, pragmas };
}

async function rejectedInitialization(
  filename: string,
  migrations: readonly MigrationMeta[]
) {
  await using runtime = ManagedRuntime.make(
    SqliteClient.layer({ filename, busyTimeout: 1_000 })
  );
  const database = await runtime.runPromise(makeWithDefaults());
  return runtime.runPromise(
    runSqliteMigrations(database, migrations, true).pipe(Effect.flip)
  );
}

describe("SQLite migration execution", () => {
  it("embeds the generated migration files exactly", () => {
    expect(sqliteMigrations).toEqual(
      readMigrationFiles({ migrationsFolder: migrationsDir })
    );
  });

  it("preserves dependent rows across a generated table rebuild", async () => {
    const fixture = await migrationFixture();
    await migrate(fixture.filename, fixture.migrations);

    const rebuild = join(fixture.migrations, "20260902000000_rebuild_parent");
    await mkdir(rebuild);
    await writeFile(
      join(rebuild, "migration.sql"),
      `
        PRAGMA foreign_keys=OFF;
        --> statement-breakpoint
        CREATE TABLE __new_parents (id text primary key) strict;
        --> statement-breakpoint
        INSERT INTO __new_parents SELECT * FROM parents;
        --> statement-breakpoint
        DROP TABLE parents;
        --> statement-breakpoint
        ALTER TABLE __new_parents RENAME TO parents;
        --> statement-breakpoint
        PRAGMA foreign_keys=ON;
      `
    );

    const pragmas = await migrate(fixture.filename, fixture.migrations);

    const inspection = new DatabaseSync(fixture.filename, { readOnly: true });
    try {
      expect(inspection.prepare("select * from children").all()).toEqual([
        { id: "child", parent_id: "parent" },
      ]);
      expect(pragmas).toEqual({ foreign_keys: 1 });
      expect(
        inspection
          .prepare("select count(*) as total from __wfgraph_sqlite_migrations")
          .get()
      ).toEqual({ total: 2 });
    } finally {
      inspection.close();
    }
  });

  it("rolls back a migration that introduces a foreign-key violation", async () => {
    const fixture = await migrationFixture();
    await migrate(fixture.filename, fixture.migrations);
    const invalid = join(fixture.migrations, "20260902000000_invalid_child");
    await mkdir(invalid);
    await writeFile(
      join(invalid, "migration.sql"),
      "insert into children values ('orphan', 'missing-parent');"
    );

    const { error, pragmas } = await rejectedMigration(
      fixture.filename,
      fixture.migrations
    );
    expect(error).toMatchObject({
      message:
        "Workflow Graph's SQLite migrations introduced a foreign-key violation",
    });
    expect(pragmas).toEqual({ foreign_keys: 1 });

    const inspection = new DatabaseSync(fixture.filename, { readOnly: true });
    try {
      expect(
        inspection.prepare("select count(*) as total from children").get()
      ).toEqual({ total: 1 });
      expect(
        inspection
          .prepare("select count(*) as total from __wfgraph_sqlite_migrations")
          .get()
      ).toEqual({ total: 1 });
    } finally {
      inspection.close();
    }
  });

  it("rolls back a migration whose resulting schema is unrecognized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wfgraph-migrations-"));
    directories.push(directory);
    const filename = join(directory, "migration.db");
    const migrations = join(directory, "migrations");
    await cp(migrationsDir, migrations, { recursive: true });

    const database = await openSqliteDatabase({
      filename,
      busyTimeoutMs: 1_000,
    });
    await database.close();

    const invalid = join(migrations, "20260902000000_invalid_schema");
    await mkdir(invalid);
    await writeFile(
      join(invalid, "migration.sql"),
      "drop index executions_started_idx;"
    );

    const error = await rejectedInitialization(
      filename,
      readMigrationFiles({ migrationsFolder: migrations })
    );
    expect(error).toMatchObject({
      message:
        "Workflow Graph's SQLite application schema does not match its migration journal",
    });

    const inspection = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            "select name from sqlite_master where type = 'index' and name = 'executions_started_idx'"
          )
          .get()
      ).toEqual({ name: "executions_started_idx" });
      expect(
        inspection
          .prepare("select count(*) as total from __wfgraph_sqlite_migrations")
          .get()
      ).toEqual({ total: 1 });
    } finally {
      inspection.close();
    }
  });
});
