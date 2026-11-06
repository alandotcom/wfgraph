/**
 * A host's Event send: the shape is checked, `resolveArrival` must answer a
 * host Event for the name with no Connection, and the data must pass that
 * Event's payload gate before the arrival reaches the event inbox under the
 * Event's own name. A refusal is `InvalidInput` whose sentence names fields
 * and rules and quotes nothing the sender wrote. The inbox row keeps `data` as
 * it arrived, since the gate's decoded value serves only Entity ID selectors.
 */

import { Effect, Result, Schema, type SchemaAST } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { payloadRejectionFields } from "#src/backend/extensions/define-event";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { catchSeamFailures } from "#src/backend/lib/effect/internal-failure";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { jsonObjectSchema } from "@wfgraph/shared/types/json";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
} from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";

// `errors: "all"` is what `formatSchemaFailure` counts the unnamed issues of.
const readOptions = {
  ...rejectUnknownKeys,
  errors: "all",
} as const satisfies SchemaAST.ParseOptions;

/**
 * One Event as a sender writes it. `id` is the sender's idempotency key: a
 * second send with the same name and id is answered with the first one's
 * inbox row while that row exists.
 */
const readEventSend = Schema.decodeUnknownResult(
  Schema.Struct({
    name: NonEmptyTrimmedString,
    data: jsonObjectSchema,
    id: Schema.optional(NonEmptyTrimmedString),
  }),
  readOptions
);

const sendLogger = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("events")
);

/**
 * Accept one Event into the inbox and wake the worker loops. Answers the inbox
 * row's id, and whether an earlier send with the same id already holds it.
 */
export const sendEvent = Effect.fn("wfgraph.event.send")(
  function* (input: unknown) {
    const parsed = readEventSend(input);
    if (Result.isFailure(parsed)) {
      return yield* new InvalidInput({
        error: formatSchemaFailure(parsed.failure.issue),
      });
    }
    const { name, data, id } = parsed.success;

    // A host send carries no Connection, so it raises a host Event only: an
    // integration-owned Event arrives through its integration's webhook.
    const extensions = yield* Extensions;
    const match = extensions.resolveArrival({ name, data, connectionId: null });
    if (match.kind === "unknown") {
      return yield* new InvalidInput({
        error: "name: No host Event has this name or arrives under it",
      });
    }
    if (match.kind === "unmatched_source") {
      return yield* new InvalidInput({
        error:
          "data: No Event arriving under this name accepts this payload's source filter value",
      });
    }
    const { event } = match;

    const refusal = yield* event.decodePayloadValue(data).pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (rejected) => rejected,
      })
    );
    if (refusal !== undefined) {
      const logger = yield* sendLogger;
      yield* logger.warn("Refused an Event send", {
        event: { name: event.name, keys: Object.keys(data).length },
        payload: payloadRejectionFields(refusal),
      });
      return yield* new InvalidInput({
        error: `Payload refused for Event "${event.name}": ${refusal.error}`,
      });
    }

    const driver = yield* ExecutionDriver;
    const received = yield* driver.receiveEvent({
      name: event.name,
      data,
      connectionId: null,
      idempotencyKey: id ?? null,
    });
    return { id: received.inboxId, duplicate: received.duplicate };
  },
  catchSeamFailures(
    sendLogger,
    "Failed to send an Event",
    "Could not send this Event"
  )
);
