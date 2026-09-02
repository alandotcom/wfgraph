import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Effect, ManagedRuntime, Predicate } from "effect";
import { sql, type SQL } from "drizzle-orm";
import {
  type EffectSQLiteNodeDatabase,
  makeWithDefaults,
} from "drizzle-orm/effect-sqlite-node";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { initializeSqlite } from "#src/backend/persistence/sqlite/migrations";
import { isSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  readJsonObject,
  readJsonValue,
  type JsonObject,
  type JsonValue,
} from "@wfgraph/shared/types/json";

/** Safe SQL literals from the closed execution-status vocabulary in shared. */
export const SQLITE_IN_FLIGHT_EXECUTION_STATUSES =
  IN_FLIGHT_EXECUTION_STATUSES.map((status) => `'${status}'`).join(", ");

export type SqliteExecutor = Pick<
  EffectSQLiteNodeDatabase,
  "all" | "get" | "run" | "values"
>;

export type SqliteDatabase = {
  readonly read: <A>(
    run: (database: SqliteExecutor) => Effect.Effect<A, unknown>
  ) => Effect.Effect<A, DatabaseError>;
  readonly write: <A>(
    run: (database: SqliteExecutor) => Effect.Effect<A, unknown>
  ) => Effect.Effect<A, DatabaseError>;
  readonly close: () => Promise<void>;
};

function sanitizeDatabaseCause(cause: unknown): unknown {
  if (Predicate.isObject(cause) && Cause.isCause(cause.cause)) {
    return Cause.squash(cause.cause);
  }
  return cause;
}

function asDatabaseError<A>(
  effect: Effect.Effect<A, unknown>
): Effect.Effect<A, DatabaseError> {
  return effect.pipe(
    Effect.mapError(
      (cause) => new DatabaseError({ cause: sanitizeDatabaseCause(cause) })
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(new DatabaseError({ cause: sanitizeDatabaseCause(cause) }))
    )
  );
}

export async function openSqliteDatabase(input: {
  filename: string;
  busyTimeoutMs: number;
}): Promise<SqliteDatabase> {
  const runtime = ManagedRuntime.make(
    SqliteClient.layer({
      filename: input.filename,
      busyTimeout: input.busyTimeoutMs,
    })
  );
  let closePromise: Promise<void> | undefined;
  try {
    const database = await runtime.runPromise(makeWithDefaults());
    await runtime.runPromise(initializeSqlite(database));

    return {
      read: (run) => asDatabaseError(Effect.suspend(() => run(database))),
      write: (run) =>
        asDatabaseError(
          database.transaction((transaction) =>
            Effect.suspend(() => run(transaction))
          )
        ),
      close: () => {
        closePromise ??= runtime.dispose();
        return closePromise;
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export function placeholders(values: readonly unknown[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  );
}

export function requiredString(
  row: Record<string, unknown>,
  key: string
): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function optionalString(
  row: Record<string, unknown>,
  key: string
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function requiredNumber(
  row: Record<string, unknown>,
  key: string
): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function optionalNumber(
  row: Record<string, unknown>,
  key: string
): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function requiredBoolean(
  row: Record<string, unknown>,
  key: string
): boolean {
  const value = requiredNumber(row, key);
  if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key}`);
  return value === 1;
}

export function optionalBoolean(
  row: Record<string, unknown>,
  key: string
): boolean | null {
  const value = optionalNumber(row, key);
  if (value === null) return null;
  if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key}`);
  return value === 1;
}

export function requiredDate(row: Record<string, unknown>, key: string): Date {
  return new Date(requiredNumber(row, key));
}

export function optionalDate(
  row: Record<string, unknown>,
  key: string
): Date | null {
  const value = optionalNumber(row, key);
  return value === null ? null : new Date(value);
}

function parseJson(row: Record<string, unknown>, key: string): unknown {
  return JSON.parse(requiredString(row, key));
}

export function requiredGraph(
  row: Record<string, unknown>,
  key = "graph"
): SerializedWorkflowGraph {
  const value = parseJson(row, key);
  if (!isSerializedWorkflowGraph(value)) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return value;
}

export function requiredVersionKind(
  row: Record<string, unknown>,
  key = "kind"
): WorkflowVersionKind {
  const value = requiredString(row, key);
  const kind = WORKFLOW_VERSION_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new Error(`Invalid SQLite ${key}`);
  return kind;
}

export function optionalJsonValue(
  row: Record<string, unknown>,
  key: string
): JsonValue | null {
  const encoded = optionalString(row, key);
  if (encoded === null) return null;
  const value = readJsonValue(JSON.parse(encoded));
  if (value === null && encoded !== "null")
    throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function optionalJsonObject(
  row: Record<string, unknown>,
  key: string
): JsonObject | null {
  const encoded = optionalString(row, key);
  if (encoded === null) return null;
  const value = readJsonObject(JSON.parse(encoded));
  if (value === null) throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function encodeJson(value: JsonValue | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function encodeGraph(value: SerializedWorkflowGraph): string {
  return JSON.stringify(value);
}
