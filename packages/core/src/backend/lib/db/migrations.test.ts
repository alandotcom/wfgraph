/**
 * Where Workflow Graph finds the SQL it ships.
 *
 * The answer has to hold in two layouts -- this source tree, and a published
 * package whose code sits one directory under its manifest -- and it has to hold
 * without ever landing on somebody else's `drizzle/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import {
  assertJournalHashesAreOurs,
  wfgraphMigrationsDir,
} from "#src/backend/lib/db/migrations";

const packageRoot = resolve(import.meta.dirname, "../../../..");

function scratchTree(): string {
  return mkdtempSync(join(tmpdir(), "wfgraph-migrations-"));
}

function writePackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
}

describe("wfgraphMigrationsDir", () => {
  it("finds the copy this package publishes", () => {
    expect(wfgraphMigrationsDir()).toBe(join(packageRoot, "drizzle"));
  });

  // The published layout: the code is a chunk in dist/, one level under the
  // manifest, rather than five levels under it as it is here.
  it("finds it from the bundled layout too", () => {
    const root = scratchTree();
    writePackage(join(root, "node_modules/@wfgraph/core"), "@wfgraph/core");

    expect(
      wfgraphMigrationsDir(join(root, "node_modules/@wfgraph/core/dist"))
    ).toBe(join(root, "node_modules/@wfgraph/core/drizzle"));
  });

  // The failure this replaces: counting `..` segments reached the adopter's own
  // drizzle-kit folder in a flat node_modules, and Workflow Graph applied their migrations
  // on its migration connection, inside its schema.
  it("cannot reach a drizzle folder outside the package", () => {
    const root = scratchTree();
    writePackage(root, "adopter-app");
    mkdirSync(join(root, "drizzle"), { recursive: true });
    writePackage(join(root, "node_modules/@wfgraph/core"), "@wfgraph/core");

    const found = wfgraphMigrationsDir(
      join(root, "node_modules/@wfgraph/core/dist")
    );

    expect(found).not.toBe(join(root, "drizzle"));
    expect(found.startsWith(join(root, "node_modules/@wfgraph/core"))).toBe(
      true
    );
  });

  it("names the package it found when the code was moved out of Workflow Graph's", () => {
    const root = scratchTree();
    writePackage(root, "adopter-app");

    expect(() => wfgraphMigrationsDir(root)).toThrow("adopter-app");
  });
});

describe("assertJournalHashesAreOurs", () => {
  const target = {
    migrationsFolder: wfgraphMigrationsDir(),
    schema: "_workflows",
  };

  it("passes a schema this build has never touched", () => {
    expect(() => assertJournalHashesAreOurs([], target)).not.toThrow();
  });

  it("passes a schema carrying a prefix of what this build ships", () => {
    const shipped = readMigrationFiles({
      migrationsFolder: target.migrationsFolder,
    }).map((migration) => migration.hash);

    expect(() =>
      assertJournalHashesAreOurs(shipped.slice(0, 1), target)
    ).not.toThrow();
  });

  // Drizzle compares no hashes, so a rebaselined set would re-run `CREATE TABLE`
  // and die on a duplicate relation with nothing said about the remedy.
  it("names the remedy for a journal from a superseded baseline", () => {
    expect(() =>
      assertJournalHashesAreOurs(["a-hash-from-the-old-baseline"], target)
    ).toThrow("Drop the _workflows schema and migrate again");
  });
});
