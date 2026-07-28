import { Effect } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { getErrorMessage } from "@rova/shared/utils";

/**
 * What a service answers when one of its seams refused it: the underlying error
 * in the log for whoever operates this, and a sentence for whoever called.
 *
 * The two seams are the database (`DatabaseError`) and Inngest
 * (`InngestError`), and both carry the same `cause`, which is why the handlers
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
 * Which of the two handlers a service uses follows from where it catches. A
 * body-level `Effect.catchTag` has the logger in hand and takes `internalFailure`;
 * a function-level `Effect.fn` transform runs outside the generator and so cannot
 * `yield*` `AppLogger` itself, which is why this one takes the logger as the
 * Effect that produces it. Handing it the same `loggerFor(...)` the body yields is
 * what lets one policy cover every query in the function.
 *
 * The wording difference is not a style choice. The editor shows this text next
 * to the graph the user was editing, and "duplicate key value violates unique
 * constraint" is what tells them their save collided; the API key screens answer
 * a fixed sentence because a caller there can do nothing with the detail.
 *
 * `callerMessage` is for the entrypoints whose log line and caller-facing
 * fallback were never the same sentence: the operator greps "Failed to start
 * workflow execution" and the caller is told "Failed to execute workflow". It
 * defaults to `message`, which is what most services want.
 */
export const internalFailureRelayingCause =
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
      return yield* Effect.fail(
        new InternalFailure({
          error: cause instanceof Error ? cause.message : callerMessage,
          cause,
        })
      );
    });

/**
 * Both seams answered by one policy, ready for `Effect.catchTags`.
 *
 * A service that both queries and enqueues has two tags to catch and one thing
 * to say about either, and spelling the handler out twice let the two drift.
 * The single `internalFailureRelayingCause` instance is what makes them the same
 * answer by construction rather than by matching text.
 */
export const seamFailureHandlers = (
  logger: Effect.Effect<EffectLogger, never, AppLogger>,
  message: string,
  callerMessage: string = message
) => {
  const handler = internalFailureRelayingCause(logger, message, callerMessage);
  return { DatabaseError: handler, InngestError: handler };
};
