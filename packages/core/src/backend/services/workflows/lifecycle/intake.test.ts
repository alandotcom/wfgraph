// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { hash } from "bcryptjs";
import { Effect, Layer, Schema } from "effect";
import {
  InvalidInput,
  NotFound,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExtensions,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import { defineEvent } from "#src/backend/lib/extensions/define-event";
import type { ApiKeyCandidate } from "#src/backend/services/api-keys/repo";
import { postEventIntake } from "./intake";

const VALID_KEY = "wfb_intake_key";

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
    }).annotate({ description: "The appointment this event is about" }),
  }),
  correlationPath: "appointment.id",
});

const appointmentCanceled = defineEvent({
  name: "app/appointment.canceled",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
    }).annotate({ description: "The appointment this event is about" }),
    kind: Schema.String.annotate({ description: "Which thing happened" }),
  }),
  correlationPath: "appointment.id",
  source: {
    event: "app/appointment.updated",
    when: { path: "kind", equals: "canceled" },
  },
});

/** Which Events this app declares, and a recorder for what was looked up. */
const catalogLookups: string[] = [];

const catalogLayer = stubExtensions({
  eventByName: (name) => {
    catalogLookups.push(name);
    if (name === appointmentCreated.name) {
      return appointmentCreated;
    }
    return name === appointmentCanceled.name ? appointmentCanceled : undefined;
  },
});

/**
 * The seams intake crosses: the key check, which is the real one over a stored
 * bcrypt hash, and the bus.
 */
function makeIntakeSeams(input: { candidates?: ApiKeyCandidate[] } = {}) {
  const sent: Array<{ name: string; deliveryId: string }> = [];

  return {
    sent,
    layer: Layer.mergeAll(
      stubApiKeyRepo({
        findByPrefix: () => Effect.succeed(input.candidates ?? []),
        touchLastUsed: () => Effect.void,
      }),
      stubInngestClient({
        sendHostEvent: (event) =>
          Effect.sync(() => {
            sent.push({ name: event.name, deliveryId: event.deliveryId });
          }),
      })
    ),
  };
}

async function storedKey(): Promise<ApiKeyCandidate[]> {
  return [{ id: "k1", keyHash: await hash(VALID_KEY, 10) }];
}

describe("postEventIntake", () => {
  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    // Credentials before the lookup: answering "not found" to an unauthenticated
    // caller would tell them which Events exist. The recorder proves the catalog
    // was never consulted.
    it.effect("refuses a request carrying no Authorization header", () =>
      Effect.gen(function* () {
        catalogLookups.length = 0;
        const seams = makeIntakeSeams();

        const failure = yield* postEventIntake({
          eventName: "app/appointment.created",
          authHeader: null,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.deepStrictEqual(catalogLookups, []);
        assert.deepStrictEqual(seams.sent, []);
      })
    );

    it.effect("refuses a header that cannot hold a key", () =>
      Effect.gen(function* () {
        catalogLookups.length = 0;
        const seams = makeIntakeSeams();

        const failure = yield* postEventIntake({
          eventName: "app/appointment.created",
          authHeader: "Bearer not-an-api-key",
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key format");
        assert.deepStrictEqual(catalogLookups, []);
      })
    );

    it.effect("refuses a well-formed key that matches nothing stored", () =>
      Effect.gen(function* () {
        catalogLookups.length = 0;
        const seams = makeIntakeSeams({
          candidates: yield* Effect.promise(storedKey),
        });

        const failure = yield* postEventIntake({
          eventName: "app/appointment.created",
          authHeader: "Bearer wfb_not_the_stored_key",
          body: { appointment: { id: "appt_1" } },
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key");
        assert.deepStrictEqual(catalogLookups, []);
      })
    );

    // The name is the sender's, so an unknown one is theirs to fix -- and a valid
    // key is what it takes to learn that much.
    it.effect("answers not found for an Event nothing declares", () =>
      Effect.gen(function* () {
        const seams = makeIntakeSeams({
          candidates: yield* Effect.promise(storedKey),
        });

        const failure = yield* postEventIntake({
          eventName: "app/appointment.moved",
          authHeader: `Bearer ${VALID_KEY}`,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(
          failure.error,
          'No Event named "app/appointment.moved" is defined'
        );
        assert.deepStrictEqual(seams.sent, []);
      })
    );

    it.effect("refuses a payload that is not the Event it arrived as", () =>
      Effect.gen(function* () {
        const seams = makeIntakeSeams({
          candidates: yield* Effect.promise(storedKey),
        });

        const failure = yield* postEventIntake({
          eventName: "app/appointment.created",
          authHeader: `Bearer ${VALID_KEY}`,
          body: { appointment: { id: 7 } },
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.include(failure.error, "appointment.id");
        // Paths and expectations only: the value came from a third party and this
        // string is answered to them and written to the log.
        assert.notInclude(failure.error, "7");
        assert.deepStrictEqual(seams.sent, []);
      })
    );

    // The bus routes by `source.when`, so a payload the sender's named Event does
    // not match would be delivered as a different Event, or as none.
    it.effect("refuses a payload its named Event does not narrow to", () =>
      Effect.gen(function* () {
        const seams = makeIntakeSeams({
          candidates: yield* Effect.promise(storedKey),
        });

        const failure = yield* postEventIntake({
          eventName: "app/appointment.canceled",
          authHeader: `Bearer ${VALID_KEY}`,
          body: { appointment: { id: "appt_1" }, kind: "rescheduled" },
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.include(
          failure.error,
          'is not Event "app/appointment.canceled"'
        );
      })
    );

    // The route accepts and enqueues: the Event's own listener is the fan-out, so
    // a run's durability is the bus's rather than this connection's.
    it.effect("puts an accepted payload on the bus under its source name", () =>
      Effect.gen(function* () {
        const seams = makeIntakeSeams({
          candidates: yield* Effect.promise(storedKey),
        });

        const accepted = yield* postEventIntake({
          eventName: "app/appointment.canceled",
          authHeader: `Bearer ${VALID_KEY}`,
          body: { appointment: { id: "appt_1" }, kind: "canceled" },
        }).pipe(Effect.provide(seams.layer));

        assert.strictEqual(accepted.eventName, "app/appointment.canceled");
        assert.strictEqual(accepted.accepted, true);
        assert.strictEqual(seams.sent[0]?.name, "app/appointment.updated");
        // The delivery id the sender was given is the one on the bus, so the 202,
        // the log line, and every row the listener writes name one arrival.
        assert.strictEqual(seams.sent[0]?.deliveryId, accepted.deliveryId);
      })
    );
  });
});
