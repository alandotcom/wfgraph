import { Context, Effect, Layer, Schema } from "effect";
import { getDb, type RovaDatabase } from "#src/backend/lib/db/index";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { getErrorMessage } from "@rova/shared/utils";

/**
 * A query did not reach the database, or the database refused it.
 *
 * `cause` is whatever `postgres.js` threw, kept so that a constraint violation
 * can be told apart from a dropped connection further up. Nothing in the backend
 * inspects it yet; the services log it and answer "internal".
 */
export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Defect(),
  }
) {}

/**
 * The database, as a service rather than a module-level handle.
 *
 * A caller hands in the query it wants run and gets back an Effect whose error
 * channel names database failure, so a service that queries can no longer forget
 * that querying fails. Repository services (`services/<domain>/repo.ts`) are the
 * only intended callers: they turn a domain question into a Drizzle query, which
 * leaves domain code free of the query builder and gives a test a place to stand
 * that needs no database.
 */
export class Database extends Context.Service<
  Database,
  {
    readonly query: <A>(
      run: (db: RovaDatabase) => Promise<A>
    ) => Effect.Effect<A, DatabaseError>;
  }
>()("Database") {}

/**
 * The live database.
 *
 * `getDb()` is called per query rather than once here, which keeps two
 * properties the app relies on: the connection pool is still opened on first use
 * rather than at startup, and this Layer shares one pool with the services that
 * have not migrated and still import the `db` proxy directly.
 *
 * Stage 3b of the Effect migration builds the handle inside this Layer from the
 * options `createRovaApp` receives and deletes `getDb` along with the
 * `globalThis` state behind it.
 */
export const DatabaseLayer: Layer.Layer<Database> = Layer.succeed(Database, {
  query: (run) =>
    Effect.tryPromise({
      try: () => run(getDb()),
      catch: (cause) => new DatabaseError({ cause }),
    }),
});

/**
 * The answer a service gives when its query failed: the underlying error in the
 * log for whoever operates this, and `message` for whoever called it.
 *
 * Written as a handler for `Effect.catchTag("DatabaseError", ...)`, which is the
 * shape the try/catch blocks that returned `failure("internal", ...)` collapse
 * into.
 */
export const internalFailure =
  (logger: EffectLogger, message: string) =>
  (databaseError: DatabaseError): Effect.Effect<never, InternalFailure> =>
    Effect.gen(function* () {
      const { cause } = databaseError;
      yield* logger.error(`${message}: ${getErrorMessage(cause)}`, {
        error: cause,
      });
      return yield* Effect.fail(new InternalFailure({ error: message, cause }));
    });
