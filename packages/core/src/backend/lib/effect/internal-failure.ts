import { Effect, Predicate } from "effect";
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
 * The seams are the database (`DatabaseError`) and the durable executor
 * (`DriverError`), and both carry the same `cause`, which is why the handlers
 * below are written against that field rather than against either class.
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
 * and bound values, which are not a public error contract.
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

/** The `_tag` of each seam failure a service may meet. */
type SeamFailureTag = "DatabaseError" | "DriverError";

type SeamFailure = { readonly _tag: SeamFailureTag; readonly cause: unknown };

const hasSeamFailureTag = Predicate.or(
  Predicate.isTagged("DatabaseError"),
  Predicate.isTagged("DriverError")
);

/** Narrows a service's error channel to the seam failures it holds. */
function isSeamFailure<E>(error: E): error is Extract<E, SeamFailure> {
  return hasSeamFailureTag(error);
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
    Effect.catchIf<
      A,
      E,
      R,
      Extract<E, SeamFailure>,
      never,
      InternalFailure,
      AppLogger
    >(
      self,
      isSeamFailure<E>,
      internalFailureFromCause(logger, message, callerMessage)
    );
