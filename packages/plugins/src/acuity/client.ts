import { Acuity, AcuityError } from "@fountain-bio/acuity";
import { getErrorMessage, StepFailure } from "@wfgraph/core/plugin";
import { Effect } from "effect";

/**
 * Acuity's SDK construction.
 *
 * Held here so tests can `vi.spyOn` the factory: a `vi.mock` of
 * `@fountain-bio/acuity` that replaces `Acuity` with a different shape per file
 * leaks across the suite when vitest runs with isolate:false.
 */
export function createAcuitySdk(userId: string, apiKey: string): Acuity {
  return new Acuity({ userId, apiKey });
}

/**
 * One call to Acuity, with the sentence that says what went wrong if it did.
 *
 * The SDK throws, and what it throws is an `AcuityError` carrying the API's own
 * message when Acuity answered and something more general when it did not, so
 * the fallback each step passes names the thing that step was doing.
 */
export function callAcuity<A>(
  fallback: string,
  call: () => Promise<A>
): Effect.Effect<A, StepFailure> {
  return Effect.tryPromise({
    try: call,
    catch: (error) =>
      new StepFailure({ message: getAcuityErrorMessage(error, fallback) }),
  });
}

export function getAcuityErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof AcuityError) {
    return error.message;
  }

  const message = getErrorMessage(error);
  if (message && message !== "Unknown error") {
    return message;
  }

  return fallback;
}
