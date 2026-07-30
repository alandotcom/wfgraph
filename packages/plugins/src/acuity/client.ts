import { Acuity, AcuityError } from "@fountain-bio/acuity";
import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/index";
import { getErrorMessage } from "@rova/shared/utils";

/**
 * The Acuity SDK, built from the step's own credentials, or the failure that
 * says which of them is missing.
 *
 * It takes the whole context rather than the credentials, so fetching them is
 * part of the one line every handler opens with. Every step starts here, which
 * is what makes the check on them written once and reported the same way.
 */
export function createAcuityClient(
  context: StepRunContext<AcuityCredentials>
): Effect.Effect<Acuity, StepFailure> {
  return Effect.flatMap(context.credentials, (credentials) => {
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
  });
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
