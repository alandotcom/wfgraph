import {
  Context,
  Duration,
  Effect,
  Layer,
  Random,
  Schedule,
  Schema,
} from "effect";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";

/**
 * A query did not reach the database, or the database refused it.
 *
 * `cause` is whatever `postgres.js` threw, kept so that a constraint violation
 * can be told apart from a dropped connection further up.
 * `serializableTransaction` reads it to retry an aborted transaction; services
 * otherwise log database failures and answer "internal".
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Defect(),
  }
) {}

/** Bounds the walk, so a cause that points at itself cannot spin a predicate. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Checks whether a failure carries this driver code, at any depth.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` carrying the failed SQL,
 * so the code sits below `error.cause` rather than on it. Reading only the first
 * link matched nothing a real database produces.
 */
export function hasDatabaseErrorCode(
  error: DatabaseError,
  code: string
): boolean {
  let cause: unknown = error.cause;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cause !== "object" || cause === null) {
      return false;
    }
    if ("code" in cause && cause.code === code) {
      return true;
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }

  return false;
}

/**
 * The database, as a service rather than a module-level handle.
 *
 * A caller hands in the query it wants run and gets back an Effect whose error
 * channel names database failure, so a service that queries cannot forget that
 * querying fails. Repository services (`services/<domain>/repo.ts`) are the
 * only intended callers: they turn a domain question into a Drizzle query, which
 * leaves domain code free of the query builder and gives a test a place to stand
 * that needs no database.
 */
export class Database extends Context.Service<
  Database,
  {
    readonly query: <A>(
      run: (db: WfGraphDatabase) => Promise<A>
    ) => Effect.Effect<A, DatabaseError>;
  }
>()("@wfgraph/core/Database") {}

/**
 * The live database, over the handle the app built.
 *
 * The handle is a parameter rather than a module lookup, so which connection a
 * repository queries on is decided by the app that owns it, and a second app in
 * the same process cannot reach the first one's rows.
 */
export function makeDatabaseLayer(db: WfGraphDatabase): Layer.Layer<Database> {
  return Layer.succeed(Database, {
    query: (run) =>
      Effect.tryPromise({
        try: () => run(db),
        catch: (cause) => new DatabaseError({ cause }),
      }),
  });
}

/**
 * The SQLSTATEs PostgreSQL raises when it aborts a whole transaction: `40001`
 * is a serialization failure and `40P01` a detected deadlock. Both roll back
 * every statement the transaction ran, so running its body again is safe.
 */
const RETRYABLE_TRANSACTION_CODES = ["40001", "40P01"];

function isRetryableTransactionFailure(error: DatabaseError): boolean {
  return RETRYABLE_TRANSACTION_CODES.some((code) =>
    hasDatabaseErrorCode(error, code)
  );
}

const TRANSACTION_RETRY_BASE_DELAY = Duration.millis(5);
const TRANSACTION_RETRY_MAX_DELAY = Duration.millis(100);
const TRANSACTION_RETRIES = 30;

/**
 * Exponential backoff with full jitter: each delay is a uniform draw between
 * zero and the capped exponential step.
 *
 * Aborted racers retry at almost the same moment when the jitter is narrow, and
 * then collide again. About one decision on a contended row commits per round,
 * so the last of N racers needs about N attempts. Drawing the whole delay at
 * random spreads the racers across the window, and the budget of attempts is
 * sized for bursts well past what one entity receives at once.
 */
const transactionRetrySchedule = Schedule.exponential(
  TRANSACTION_RETRY_BASE_DELAY,
  2
).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.map(Random.next, (draw) =>
      Duration.millis(
        Duration.toMillis(Duration.min(duration, TRANSACTION_RETRY_MAX_DELAY)) *
          draw
      )
    )
  ),
  Schedule.upTo({ times: TRANSACTION_RETRIES })
);

/**
 * Runs `run` as one `SERIALIZABLE` transaction, and runs it again from the start
 * whenever PostgreSQL aborts it with `40001` or `40P01`.
 *
 * `run` is repeated, so every effect it has must happen inside the transaction.
 * Any other failure, or the last abort once the retries are spent, reaches the
 * caller as a `DatabaseError`.
 */
export function serializableTransaction<A>(
  database: Database["Service"],
  run: (tx: WfGraphTransaction) => Promise<A>
): Effect.Effect<A, DatabaseError> {
  return database
    .query((db) => db.transaction(run, { isolationLevel: "serializable" }))
    .pipe(
      Effect.retry({
        schedule: transactionRetrySchedule,
        while: isRetryableTransactionFailure,
      })
    );
}
