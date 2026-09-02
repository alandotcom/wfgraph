import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "#src/backend/lib/db/schema";
import { INTEGRATION_REFRESH_STATES } from "@wfgraph/shared/types/integration";

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

  // `db.query` is keyed off `relations`, which is built from `tables`. A table
  // exported from this module but missing from that bag is invisible to every
  // repository that reaches for `db.query.<name>`.
  it("registers every declared table on the relational surface", () => {
    // Table names are identifiers, so code-unit order is enough here.
    // `compareText` is for text a person reads.
    const declaredNames = new Set(Object.keys(schema.tables).toSorted());
    const relationNames = new Set(Object.keys(schema.relations).toSorted());

    expect([...declaredNames]).toEqual([...relationNames]);
    expect(declaredNames.size).toBe(declaredTables.length);
  });
});

describe("OAuth persistence", () => {
  it("stores durable authorization attempts under their state hash", () => {
    const config = getTableConfig(schema.oauthAuthorizationAttempts);

    expect(config.columns.map((column) => column.name)).toEqual([
      "state_hash",
      "integration_id",
      "mode",
      "status",
      "expires_at",
      "browser_binding_hash",
      "encrypted_payload",
      "result_integration_id",
      "created_at",
      "updated_at",
    ]);
    expect(config.primaryKeys).toHaveLength(0);
    expect(schema.oauthAuthorizationAttempts.stateHash.primary).toBe(true);
    expect(schema.oauthAuthorizationAttempts.integrationId.notNull).toBe(false);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "oauth_authorization_attempts_integration_id_idx"
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "oauth_authorization_attempts_expires_at_idx"
    );
    expect(schema.oauthAuthorizationAttempts.mode.notNull).toBe(true);
    expect(schema.oauthAuthorizationAttempts.status.notNull).toBe(true);
    expect(schema.oauthAuthorizationAttempts.status.default).toBe("pending");
    expect(schema.oauthAuthorizationAttempts.resultIntegrationId.notNull).toBe(
      false
    );
    expect(schema.oauthAuthorizationAttempts.updatedAt.notNull).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "oauth_authorization_attempts_mode_check",
        "oauth_authorization_attempts_status_check",
      ])
    );
  });

  it("gives every integration an idle refresh state at config revision zero", () => {
    const config = getTableConfig(schema.integrations);

    expect(schema.integrations.configRevision.notNull).toBe(true);
    expect(schema.integrations.configRevision.default).toBe(0);
    expect(schema.integrations.refreshState.notNull).toBe(true);
    expect(schema.integrations.refreshState.default).toBe(
      INTEGRATION_REFRESH_STATES[0]
    );
    expect(schema.integrations.refreshClaimId.notNull).toBe(false);
    expect(schema.integrations.refreshClaimedAt.notNull).toBe(false);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "integrations_refresh_state_check"
    );
  });
});

describe("workflows indexes", () => {
  // published_version_id is `on delete set null`, and the version sweep at
  // publish is what makes a workflow_versions delete happen at all. Without an
  // index on this column, every version deleted scans the whole workflows table
  // for a row to null out, and the sweep's own predicate scans it a second time.
  it("indexes published_version_id, which a workflow_versions delete sets null through", () => {
    const names = getTableConfig(schema.workflows).indexes.map(
      (index) => index.config.name
    );

    expect(names).toContain("workflows_published_version_id_idx");
  });
});

describe("workflow_versions indexes", () => {
  // No query in repo.ts orders or filters on published_at: latest and history
  // reads order by version, while direct and current reads look up by id. The
  // unique (workflow_id, version) index serves every ordered version read, so a
  // published_at index would add a btree insert for a column nothing searches.
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
