import { Context, Effect, Layer, Schema } from "effect";
import { getDb, type RovaDatabase } from "#src/backend/lib/db/index";

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
 * Stage 7 of the Effect migration builds the handle inside this Layer from the
 * options `createRovaApp` receives and deletes `getDb` along with the
 * `globalThis` state behind it. It outlives stage 3b because the run engine
 * reads the same handle from outside any runtime: the workflow function's step
 * store, the step logger, and the credential fetcher all import the `db` proxy,
 * and none of them is reached through an Effect yet.
 */
export const DatabaseLayer: Layer.Layer<Database> = Layer.succeed(Database, {
  query: (run) =>
    Effect.tryPromise({
      try: () => run(getDb()),
      catch: (cause) => new DatabaseError({ cause }),
    }),
});

/**
 * Run a call into one of the `backend/lib` modules that holds its own database
 * handle, and give it the same typed error channel a query gets.
 *
 * Those modules query through the `db` proxy rather than through this service,
 * so a caller that delegates to one needs the `DatabaseError` mapping without
 * needing the `Database` service. A repository that writes its own Drizzle takes
 * `Database` instead. A helper that mixes queries with an Inngest send is not
 * one of these; `callInngestModule` is its seam.
 *
 * This goes away with `getDb`, in stage 7: once those modules run their queries
 * on the handle the Layer owns, their callers go back to `database.query`.
 */
export const callDbModule = <A>(
  run: () => Promise<A>
): Effect.Effect<A, DatabaseError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DatabaseError({ cause }),
  });
