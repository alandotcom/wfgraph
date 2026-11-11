/**
 * The statement a host that shares Workflow Graph's database runs inside its
 * own transaction to raise an Event, as docs/events.md and `workflowEventInbox`
 * in `lib/db/schema.ts` document it. It takes `$1` the Event name, `$2` the
 * payload and `$3` the idempotency key or null. The columns and the conflict
 * clause are a public contract, the same on both backends.
 */

/**
 * The insert as one backend takes it. `data` says what `$2` holds: the payload
 * object on PostgreSQL, which a driver encodes for the `jsonb` column itself,
 * or the payload as JSON text on SQLite, whose column stores text.
 */
export type InboxInsertStatement = {
  readonly sql: string;
  readonly data: "object" | "json_text";
};

/**
 * The documented insert, against `schema`'s table when one is named and the
 * connection's own `search_path` otherwise. A PostgreSQL schema name has passed
 * `normalizeDatabaseConfig`, so it is an unquoted lowercase identifier.
 */
export function inboxInsertSql(schema?: string): string {
  const table =
    schema === undefined
      ? "workflow_event_inbox"
      : `${schema}.workflow_event_inbox`;
  return [
    `insert into ${table} (name, data, idempotency_key)`,
    "values ($1, $2, $3)",
    "on conflict do nothing",
  ].join("\n");
}
