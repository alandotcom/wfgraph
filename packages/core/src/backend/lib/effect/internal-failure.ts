import { Effect } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { getErrorMessage } from "@wfgraph/shared/utils";

/**
 * What a service answers when one of its seams refused it: the underlying error
 * in the log for whoever operates this, and a sentence for whoever called.
 *
 * The seams are the database (`DatabaseError`), Inngest (`InngestError`) and
 * the durable executor (`DriverError`), and all three carry the same `cause`,
 * which is why the handlers below are written against that field rather than
 * against any one class.
 */

/**
 * The answer a service gives when its query failed.
 *
 * Written as a handler for `Effect.catchTag("DatabaseError", ...)`, which is the
 * shape the try/catch blocks that returned `failure("internal", ...)` collapse
 * into. It takes a logger rather than the Effect that produces one, because its
 * callers catch inside the generator body where `AppLogger` has already been
 * yielded.
 */
export const internalFailure =
  (logger: EffectLogger, message: string) =>
  (seamFailure: {
    readonly cause: unknown;
  }): Effect.Effect<never, InternalFailure> =>
    Effect.gen(function* () {
      const { cause } = seamFailure;
      yield* logger.error(`${message}: ${getErrorMessage(cause)}`, {
        error: cause,
      });
      return yield* new InternalFailure({ error: message, cause });
    });

/**
 * The same answer for a function-level catch, where the logger is still an
 * Effect rather than a value the generator already yielded.
 *
 * Which of the two handlers a service uses follows from where it catches. A
 * body-level `Effect.catchTag` has the logger in hand and takes `internalFailure`;
 * a function-level `Effect.fn` transform runs outside the generator and so cannot
 * `yield*` `AppLogger` itself, which is why this one takes the logger as the
 * Effect that produces it. Handing it the same `loggerFor(...)` the body yields is
 * what lets one policy cover every query in the function.
 *
 * `callerMessage` is for the entrypoints whose log line and caller-facing
 * fallback were never the same sentence: the operator greps "Failed to start
 * workflow execution" and the caller is told "Failed to execute workflow". It
 * defaults to `message`, which is what most services want.
 *
 * The cause stays in the operator log and on the non-serialized failure object.
 * The caller gets only `callerMessage`: database errors can contain query text
 * and bound values, while Inngest errors can contain request details, and none
 * of those are a public error contract.
 */
export const internalFailureFromCause =
  (
    logger: Effect.Effect<EffectLogger, never, AppLogger>,
    message: string,
    callerMessage: string = message
  ) =>
  (seamFailure: {
    readonly cause: unknown;
  }): Effect.Effect<never, InternalFailure, AppLogger> =>
    Effect.gen(function* () {
      const { cause } = seamFailure;
      const serviceLogger = yield* logger;
      yield* serviceLogger.error(`${message}: ${getErrorMessage(cause)}`, {
        error: cause,
      });
      return yield* new InternalFailure({
        error: callerMessage,
        cause,
      });
    });

/**
 * The same answer with the cause kept out of it for an external caller. The
 * caller gets a stated sentence; the cause goes to the log for the operator.
 *
 * It takes the logger as the Effect that produces one for the same reason the
 * function-level handler does: both are used from an `Effect.fn` transform, which runs
 * outside the generator that could have yielded `AppLogger`.
 */
const statedInternalFailure =
  (
    logger: Effect.Effect<EffectLogger, never, AppLogger>,
    message: string,
    callerMessage: string
  ) =>
  (seamFailure: {
    readonly cause: unknown;
  }): Effect.Effect<never, InternalFailure, AppLogger> =>
    Effect.gen(function* () {
      const { cause } = seamFailure;
      const serviceLogger = yield* logger;
      yield* serviceLogger.error(`${message}: ${getErrorMessage(cause)}`, {
        error: cause,
      });
      return yield* new InternalFailure({ error: callerMessage, cause });
    });

/** The `_tag` of each seam failure a service may meet. */
type SeamFailureTag = "DatabaseError" | "InngestError" | "DriverError";

type SeamFailure = { readonly _tag: SeamFailureTag; readonly cause: unknown };

const seamFailureTags: ReadonlySet<string> = new Set<SeamFailureTag>([
  "DatabaseError",
  "InngestError",
  "DriverError",
]);

/** Whether `error` is one of the seam failures, whichever the caller can meet. */
function isSeamFailure<E>(error: E): error is Extract<E, SeamFailure> {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    seamFailureTags.has(error._tag)
  );
}

/**
 * Every seam failure answered by one policy, as a pipeable step.
 *
 * A service that both queries and enqueues meets more than one seam and has
 * one thing to say about any of them. One handler instance answers each seam
 * failure in the Effect's error channel, so the answers are the same by
 * construction, and a service whose error channel holds only some of the seams
 * uses the same step.
 */
export const catchSeamFailures =
  (
    logger: Effect.Effect<EffectLogger, never, AppLogger>,
    message: string,
    callerMessage: string = message
  ) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    Exclude<E, Extract<E, SeamFailure>> | InternalFailure,
    R | AppLogger
  > =>
    Effect.catchIf(
      self,
      isSeamFailure<E>,
      internalFailureFromCause(logger, message, callerMessage),
      Effect.fail
    );

/**
 * Every seam failure answered with one stated sentence, keeping storage and
 * request details private, as a pipeable step.
 */
export const catchStatedSeamFailures =
  (
    logger: Effect.Effect<EffectLogger, never, AppLogger>,
    message: string,
    callerMessage: string
  ) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    Exclude<E, Extract<E, SeamFailure>> | InternalFailure,
    R | AppLogger
  > =>
    Effect.catchIf(
      self,
      isSeamFailure<E>,
      statedInternalFailure(logger, message, callerMessage),
      Effect.fail
    );
