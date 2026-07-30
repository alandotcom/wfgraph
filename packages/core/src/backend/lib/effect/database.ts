import { Context, Effect, Layer, Schema } from "effect";
import type { RovaDatabase } from "#src/backend/lib/db/index";

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
 * The live database, over the handle the app built.
 *
 * The handle is a parameter rather than a module lookup, so which connection a
 * repository queries on is decided by the app that owns it, and a second app in
 * the same process cannot reach the first one's rows.
 */
export function makeDatabaseLayer(db: RovaDatabase): Layer.Layer<Database> {
  return Layer.succeed(Database, {
    query: (run) =>
      Effect.tryPromise({
        try: () => run(db),
        catch: (cause) => new DatabaseError({ cause }),
      }),
  });
}
