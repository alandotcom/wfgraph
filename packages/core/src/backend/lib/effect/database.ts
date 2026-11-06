import {
  Context,
  Duration,
  Effect,
  Layer,
  Random,
  Schedule,
  Schema,
} from "effect";
import { DrizzleQueryError } from "drizzle-orm";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";

/**
 * A query did not reach the database, or the database refused it.
 *
 * `cause` is what the driver threw, kept so that a constraint violation can be
 * told apart from a dropped connection further up. A failed query arrives as a
 * `QueryFailed` holding the SQL text, with the driver's error under it, and
 * never carries the values the query bound.
 * `serializableTransaction` reads it to retry an aborted transaction; services
 * otherwise log database failures and answer "internal".
 */
export class DatabaseError extends Schema.TaggedError<
  DatabaseError,
  { readonly brand: unique symbol }
>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}

/**
 * A write of one database executor pass that was not made, because the pass no
 * longer acts on its run.
 *
 * The repository raises it when the Execution's schedule row no longer names
 * the pass's owner token: the lease expired and another claim took the run, or
 * a terminal write, a policy cancel or a release cleared the row. The executor
 * raises it for every write a pass attempts after it stopped. Nothing failed in
 * the database, and the write collides with no domain state, so the pass ends
 * where it stands; the engine never reads it as a node's failure.
 */
export class LeaseLost extends Schema.TaggedError<
  LeaseLost,
  { readonly brand: unique symbol }
>()("LeaseLost", {
  message: Schema.String,
}) {}

/**
 * The fields of a driver error that name the failure and quote nothing the
 * query bound. postgres.js also puts the query's `parameters` and `args` on
 * the error, as properties a debug connection makes enumerable, and a
 * constraint violation's `detail` and `where` quote the row or key that
 * failed, which can hold an Event's payload. None of those are kept.
 */
const DRIVER_ERROR_FIELDS = [
  "code",
  "errno",
  "severity",
  "schema_name",
  "table_name",
  "column_name",
  "constraint_name",
  "routine",
] as const;

/**
 * A copy of a driver error holding its message, name, stack and the fields
 * in `DRIVER_ERROR_FIELDS`, and nothing else. Anything that is not an `Error`
 * is answered as it is.
 */
function withoutBoundValues(driverError: unknown): unknown {
  if (!(driverError instanceof Error)) return driverError;
  const copy = new Error(driverError.message);
  copy.name = driverError.name;
  if (driverError.stack !== undefined) copy.stack = driverError.stack;
  for (const field of DRIVER_ERROR_FIELDS) {
    if (field in driverError) {
      Reflect.set(copy, field, Reflect.get(driverError, field));
    }
  }
  return copy;
}

/**
 * A query the database refused or never received: the SQL text it ran, with
 * the driver's error as `cause`, stripped to the fields that name the failure.
 * The values the query bound are left out, because they can be an Event's
 * payload or a credential, and this error reaches logs, a host's
 * `Error.cause`, and Inngest.
 */
export class QueryFailed extends Error {
  override readonly name = "QueryFailed";
  readonly query: string;

  constructor(query: string, driverError: unknown) {
    super(`Failed query: ${query}`, {
      cause: withoutBoundValues(driverError),
    });
    this.query = query;
  }
}

/**
 * Replaces Drizzle's `DrizzleQueryError`, whose message can list the query's
 * bound values, with a `QueryFailed`. Any other failure is answered as it is.
 */
export function withoutQueryParams(cause: unknown): unknown {
  return cause instanceof DrizzleQueryError
    ? new QueryFailed(cause.query, cause.cause)
    : cause;
}

/** Bounds the walk, so a cause that points at itself cannot spin a predicate. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Checks whether a failure carries this driver code, at any depth.
 *
 * A failed query's driver error sits under the `QueryFailed` carrying its SQL,
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
        catch: (cause) =>
          new DatabaseError({ cause: withoutQueryParams(cause) }),
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
