import { Acuity, AcuityError } from "@fountain-bio/acuity";
import { StepFailure } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import { getErrorMessage } from "@rova/shared/utils";

/**
 * The Acuity SDK, built from the integration's credentials, or the failure that
 * says which of them is missing.
 *
 * Every step starts here, so the credentials check is written once and every
 * step reports it the same way.
 */
export function createAcuityClient(
  credentials: AcuityCredentials
): Effect.Effect<Acuity, StepFailure> {
  const userId = credentials.ACUITY_USER_ID?.trim();
  const apiKey = credentials.ACUITY_API_KEY?.trim();

  return userId && apiKey
    ? Effect.succeed(new Acuity({ userId, apiKey }))
    : Effect.fail(
        new StepFailure({
          message:
            "ACUITY_USER_ID and ACUITY_API_KEY are required. Add them in Project Integrations.",
        })
      );
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
