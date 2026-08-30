/**
 * The shared `/i/v0/e/` path both PostHog actions take.
 *
 * Handlers stay inline in `defineIntegration` so `bag.input` keeps its
 * contextual type. What they share is the connection, the memoized identity,
 * and turning a client failure into the step's.
 */

import { StepFailure } from "@wfgraph/core/plugin";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  captureEvent,
  describePostHogFailure,
  type PostHogConnection,
  type PostHogEvent,
  resolvePostHogHost,
} from "#src/posthog/client";

const MISSING_CREDENTIAL =
  "POSTHOG_PROJECT_API_KEY is not configured. Please add it in Project Integrations.";

/**
 * The uuid and timestamp an event is sent under, taken in a step of their own.
 *
 * This is what makes a resend safe. PostHog has no idempotency key and
 * deduplicates on `[timestamp, distinct_id, event, uuid]`, so two attempts
 * collapse only when both of these are the same on each. Memoizing them means
 * every attempt -- `callExternal`'s retry inside the step, a resumed run
 * replaying it, Inngest retrying the whole function -- sends bytes identical to
 * the ones that may already have arrived. Taking either inside the send itself
 * would leave two events instead of one.
 *
 * PostHog's dedup runs during background merges, so it is eventual: a duplicate
 * can show in insights before it merges away. The trade is deliberate, because
 * a dropped analytics event is a hole nobody can reconstruct.
 */
export const eventIdentity = Effect.sync(() => ({
  uuid: globalThis.crypto.randomUUID(),
  timestamp: new Date().toISOString(),
}));

export function connectionFrom(credentials: {
  readonly POSTHOG_PROJECT_API_KEY?: string;
  readonly POSTHOG_HOST?: string;
}): Effect.Effect<PostHogConnection, StepFailure> {
  const projectApiKey = credentials.POSTHOG_PROJECT_API_KEY;

  if (!projectApiKey) {
    return Effect.fail(new StepFailure({ message: MISSING_CREDENTIAL }));
  }

  return Effect.succeed({
    projectApiKey,
    host: resolvePostHogHost(credentials.POSTHOG_HOST),
  });
}

export function captureOrFail(
  message: string,
  connection: PostHogConnection,
  event: PostHogEvent
): Effect.Effect<unknown, StepFailure, HttpClient.HttpClient> {
  return captureEvent(connection, event).pipe(
    Effect.mapError(
      (error) =>
        new StepFailure({
          message: `${message}: ${describePostHogFailure(error)}`,
        })
    )
  );
}
