import {
  type CredentialsUnavailable,
  type StepBag,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect } from "effect";
import type { Acuity } from "@fountain-bio/acuity";
import { createAcuitySdk } from "#src/acuity/client";

/**
 * Builds the SDK from the step bag. Lives outside `client.ts` so a spy on
 * `createAcuitySdk` is visible: same-module calls would keep the unspied
 * binding (see Linear's `createLinearClient` in its own module).
 */
type AcuityCredentials = {
  ACUITY_USER_ID?: string;
  ACUITY_API_KEY?: string;
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
      ? Effect.succeed(createAcuitySdk(userId, apiKey))
      : Effect.fail(
          new StepFailure({
            message:
              "ACUITY_USER_ID and ACUITY_API_KEY are required. Add them in Project Integrations.",
          })
        );
  });
}
