import { Acuity, AcuityError } from "@fountain-bio/acuity";
import {
  type CredentialsUnavailable,
  getErrorMessage,
  type StepBag,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/index";

/**
 * SDK construction. Held on an object so tests can `vi.spyOn` it: a same-module
 * function call would not see an export spy, and a `vi.mock` of
 * `@fountain-bio/acuity` leaks across files when vitest runs with isolate:false.
 */
export const acuitySdk = {
  build(userId: string, apiKey: string): Acuity {
    return new Acuity({ userId, apiKey });
  },
};

/**
 * The Acuity SDK, built from the step's own credentials, or the failure that
 * says which of them is missing.
 *
 * It takes the handler's whole bag rather than the credentials, so fetching them
 * is part of the one line every handler opens with. Every step starts here, which
 * is what makes the check on them written once and reported the same way.
 *
 * A store that could not be read is passed on rather than turned into a
 * `StepFailure`: that failure is the one a step is retried for.
 */
export function createAcuityClient(
  bag: StepBag<unknown, AcuityCredentials>
): Effect.Effect<Acuity, StepFailure | CredentialsUnavailable> {
  return Effect.flatMap(bag.credentials, (credentials) => {
    const userId = credentials.ACUITY_USER_ID?.trim();
    const apiKey = credentials.ACUITY_API_KEY?.trim();

    return userId && apiKey
      ? Effect.succeed(acuitySdk.build(userId, apiKey))
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
