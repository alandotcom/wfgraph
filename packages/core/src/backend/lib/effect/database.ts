import { Context, Effect, Layer, Schema } from "effect";
import { getDb, type RovaDatabase } from "#src/backend/lib/db/index";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
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
 * Run a call into one of the `backend/lib/db/*` modules and give it the same
 * typed error channel a query gets.
 *
 * Those modules hold their own handle, so a repository that delegates to one
 * needs the `DatabaseError` mapping without needing the `Database` service. A
 * repository that writes its own Drizzle takes `Database` instead.
 *
 * This goes away with `getDb`, at the end of stage 3b: once those modules run
 * their queries on the handle the Layer owns, their repositories go back to
 * `database.query`.
 */
export const callDbModule = <A>(
  run: () => Promise<A>
): Effect.Effect<A, DatabaseError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DatabaseError({ cause }),
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

/**
 * The same answer, except that the caller reads the message from underneath.
 *
 * Every service in the workflows domain words its failure this way: a thrown
 * `Error` hands its own message to whoever called, and `message` is the fallback
 * for something thrown that was not an `Error`. The log line is unchanged, so
 * `message` is still what an operator greps for.
 *
 * Which of the two a service uses is not a style choice. The editor shows this
 * text next to the graph the user was editing, and "duplicate key value violates
 * unique constraint" is what tells them their save collided; the API key screens
 * answer a fixed sentence because a caller there can do nothing with the detail.
 *
 * The logger arrives as the Effect that produces it rather than as a logger,
 * because the workflows services state this policy once for a whole function, in
 * an `Effect.fn` transform. A transform runs outside the generator body and so
 * cannot `yield*` `AppLogger` itself; handing it the same `loggerFor(...)` the
 * body yields is what lets one policy cover every query in the function. The
 * `internalFailure` above still takes a logger, because its callers still catch
 * inside the body; batch 3 of stage 3b brings them across.
 */
export const internalFailureRelayingCause =
  (logger: Effect.Effect<EffectLogger, never, AppLogger>, message: string) =>
  (
    databaseError: DatabaseError
  ): Effect.Effect<never, InternalFailure, AppLogger> =>
    Effect.gen(function* () {
      const { cause } = databaseError;
      const serviceLogger = yield* logger;
      yield* serviceLogger.error(`${message}: ${getErrorMessage(cause)}`, {
        error: cause,
      });
      return yield* Effect.fail(
        new InternalFailure({
          error: cause instanceof Error ? cause.message : message,
          cause,
        })
      );
    });
