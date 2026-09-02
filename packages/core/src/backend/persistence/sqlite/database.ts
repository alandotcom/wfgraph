import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Effect, ManagedRuntime, Predicate } from "effect";
import {
  type EffectSQLiteNodeDatabase,
  makeWithDefaults,
} from "drizzle-orm/effect-sqlite-node";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { initializeSqlite } from "#src/backend/persistence/sqlite/migrations";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { JsonValue } from "@wfgraph/shared/types/json";

export type SqliteReadExecutor = Pick<
  EffectSQLiteNodeDatabase,
  "select" | "selectDistinct"
>;

export type SqliteExecutor = SqliteReadExecutor &
  Pick<EffectSQLiteNodeDatabase, "delete" | "insert" | "run" | "update">;

export type SqliteDatabase = {
  readonly read: <A>(
    run: (database: SqliteReadExecutor) => Effect.Effect<A, unknown>
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

export function encodeJson(value: JsonValue | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function encodeGraph(value: SerializedWorkflowGraph): string {
  return JSON.stringify(value);
}
