import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "#src/backend/lib/db/schema";

// Read off the module rather than listed by hand, so a table added tomorrow is
// held to the rule below without anyone remembering to add it here.
const declaredTables = Object.values<unknown>(schema).filter(
  (exported: unknown): exported is PgTable => is(exported, PgTable)
);

describe("the schema declarations", () => {
  it("declare tables at all", () => {
    expect(declaredTables.length).toBeGreaterThan(0);
  });

  // The whole of `database.schema` rests on this: an unqualified table is
  // resolved through the connection's search_path, and one table that names a
  // schema would go on living in that schema whatever the host configured.
  it("name no schema, so search_path decides where the tables live", () => {
    const qualified = declaredTables
      .map((table) => getTableConfig(table))
      .filter((table) => table.schema !== undefined)
      .map((table) => table.name);

    expect(qualified).toEqual([]);
  });
});

describe("workflow_versions indexes", () => {
  // No query in repo.ts orders or filters on published_at: findLatestVersion and
  // findVersionByContent both order by version, findVersionById and
  // findPublishedVersion both look up by id. The unique (workflow_id, version)
  // index already serves every existing version read, so this index pays a
  // second btree insert on every publish for a column nothing reads.
  it("carries no index on published_at", () => {
    const names = getTableConfig(schema.workflowVersions).indexes.map(
      (index) => index.config.name
    );

    expect(names).not.toContain(
      "workflow_versions_workflow_id_published_at_idx"
    );
  });
});

describe("workflow_executions indexes", () => {
  // workflow_version_id cascades from workflow_versions (a version delete
  // removes every execution pinned to it). Without an index on this column,
  // that cascade scans the whole executions table -- the largest table in the
  // schema -- to find the rows to delete.
  it("indexes workflow_version_id, which a workflow_versions delete cascades through", () => {
    const names = getTableConfig(schema.workflowExecutions).indexes.map(
      (index) => index.config.name
    );

    expect(names).toContain("workflow_executions_workflow_version_id_idx");
  });
});
