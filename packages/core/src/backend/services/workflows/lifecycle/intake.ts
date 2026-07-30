/**
 * HTTP intake: one app-level route for every Event.
 *
 * An Event is global and declared in code, so a sender integrates once and every
 * workflow subscribing to that Event sees what arrives. A per-workflow URL would
 * mean an Event posted for one workflow could not reach another, which is a
 * statement no part of the model makes.
 *
 * The route accepts and enqueues; it does not deliver. Fanning out inside the
 * request would tie a run's durability to an HTTP connection, so the payload goes
 * onto the bus and the Event's own listener is the only fan-out. What comes back
 * says the delivery was accepted and nothing about the workflows behind it: this
 * endpoint answers third parties across origins, and workflow and run ids are not
 * theirs to read.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InvalidInput, NotFound } from "#src/backend/lib/effect/failures";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { statedInternalFailure } from "#src/backend/lib/effect/internal-failure";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { validateApiKey } from "#src/backend/services/api-keys/auth";
import type { JsonObject } from "@rova/shared/types/json";
import { generateId } from "@rova/shared/utils/id";
import { eventSourceMatches } from "@rova/shared/workflow/inngest-event-data";

/** What a sender is told: the Event they named, and that the delivery is ours. */
export type EventIntakeAccepted = {
  eventName: string;
  accepted: true;
  /** Names this arrival in Rova's logs and in every run it goes on to start. */
  deliveryId: string;
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (eventName: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "event-intake").with({ eventName })
  );

export const postEventIntake = Effect.fn("postEventIntake")(
  function* (input: {
    eventName: string;
    authHeader: string | null;
    /**
     * The request's JSON body. It goes through the Event's gate and onto the bus
     * unchanged, so JSON is the whole of its contract.
     */
    body: JsonObject;
  }) {
    const logger = yield* loggerFor(input.eventName);
    const inngest = yield* InngestClient;

    // Credentials before the lookup: answering "not found" versus
    // "unauthorized" to an unauthenticated caller tells them which Events exist,
    // and this route is reachable without a session by design.
    const { keyId } = yield* validateApiKey(input.authHeader);

    const event = (yield* Extensions).eventByName(input.eventName);
    if (!event) {
      return yield* Effect.fail(
        new NotFound({
          error: `No Event named "${input.eventName}" is defined`,
        })
      );
    }

    // The gate is here rather than in the fan-out because this is where a
    // refusal has somewhere to go: the sender reads it as a 400 and can fix the
    // payload. The listener gates again, for what arrives by other routes.
    yield* event
      .decodePayload(input.body)
      .pipe(
        Effect.catchTag("PayloadRejected", (rejected) =>
          logger
            .warn("Refused an event payload", { error: rejected.detail })
            .pipe(
              Effect.andThen(
                Effect.fail(new InvalidInput({ error: rejected.error }))
              )
            )
        )
      );

    // An Event narrowing an umbrella source is only that Event when the payload
    // says so. The bus routes by `source.when`, so without this a mismatch would
    // be accepted here and then delivered as a different Event, or as none.
    const when = event.source.when;
    if (when && !eventSourceMatches(when, input.body)) {
      return yield* Effect.fail(
        new InvalidInput({
          error: `Payload is not Event "${event.name}": the value at "${when.path}" identifies it as something else`,
        })
      );
    }

    const deliveryId = generateId();

    yield* inngest.sendHostEvent({
      name: event.source.event,
      data: input.body,
      deliveryId,
    });

    yield* logger.info("Event accepted", {
      deliveryId,
      keyId,
      sourceEvent: event.source.event,
    });

    const accepted: EventIntakeAccepted = {
      eventName: event.name,
      accepted: true,
      deliveryId,
    };
    return accepted;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "InngestError",
        statedInternalFailure(
          loggerFor(input.eventName),
          "Failed to enqueue an accepted event",
          "Could not accept the event"
        )
      )
    )
);
