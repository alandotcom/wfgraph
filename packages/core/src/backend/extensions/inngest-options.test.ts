/**
 * The fixture crosses the Standard Schema bridge before it gets here, which is
 * the shape `defineEvent` hands this module: the identifier check reads the
 * schema object's own field names, so a bridged schema is what is under test.
 * What the rewrite does with an identifier once those names are in hand is
 * `inngest-event-data.test.ts` in @rova/shared.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { rewriteInngestOptions } from "#src/backend/extensions/inngest-options";
import {
  type StandardSchema,
  toStandardSchema,
} from "@rova/shared/types/schema";

const appointmentPayloadSchema = Schema.Struct({
  event: Schema.String.annotate({ description: "What happened" }),
  appointment: Schema.Struct({
    id: Schema.String.annotate({ description: "Appointment ID" }),
    priority: Schema.String.annotate({ description: "Appointment priority" }),
  }).annotate({ description: "The appointment this event is about" }),
});

type AppointmentPayload = (typeof appointmentPayloadSchema)["Type"];

const appointmentPayload: StandardSchema<AppointmentPayload> = toStandardSchema(
  appointmentPayloadSchema
);

describe("rewriteInngestOptions keys", () => {
  it("prefixes a rateLimit key with event.data.", () => {
    expect(
      rewriteInngestOptions(
        "app/rate.limited",
        { rateLimit: { limit: 5, period: "1m", key: "appointment.id" } },
        appointmentPayload
      )
    ).toEqual({
      rateLimit: { limit: 5, period: "1m", key: "event.data.appointment.id" },
    });
  });

  it("prefixes a throttle key and keeps its burst", () => {
    expect(
      rewriteInngestOptions(
        "app/throttled",
        {
          throttle: {
            limit: 10,
            period: "1h",
            key: "appointment.id",
            burst: 2,
          },
        },
        appointmentPayload
      )
    ).toEqual({
      throttle: {
        limit: 10,
        period: "1h",
        key: "event.data.appointment.id",
        burst: 2,
      },
    });
  });

  it("prefixes a debounce key", () => {
    expect(
      rewriteInngestOptions(
        "app/debounced",
        { debounce: { period: "5s", key: "appointment.id", timeout: "1h" } },
        appointmentPayload
      )
    ).toEqual({
      debounce: {
        period: "5s",
        key: "event.data.appointment.id",
        timeout: "1h",
      },
    });
  });

  it("leaves a keyless rateLimit alone rather than inventing a prefix", () => {
    expect(
      rewriteInngestOptions(
        "app/rate.keyless",
        { rateLimit: { limit: 5, period: "1m" } },
        appointmentPayload
      )
    ).toEqual({ rateLimit: { limit: 5, period: "1m" } });
  });

  it("passes timeouts and retries through untouched", () => {
    expect(
      rewriteInngestOptions(
        "app/timeouts",
        { timeouts: { start: "1h", finish: "2h" }, retries: 3 },
        appointmentPayload
      )
    ).toEqual({ timeouts: { start: "1h", finish: "2h" }, retries: 3 });
  });
});

describe("rewriteInngestOptions priority", () => {
  it("reads the identifier check's field names off the payload schema", () => {
    expect(
      rewriteInngestOptions(
        "app/priority",
        { priority: { run: 'appointment.priority == "high" ? 100 : 50' } },
        appointmentPayload
      )
    ).toEqual({
      priority: { run: 'event.data.appointment.priority == "high" ? 100 : 50' },
    });
  });

  it("refuses a priority.run naming something the payload does not declare", () => {
    expect(() =>
      rewriteInngestOptions(
        "app/priority.unknown",
        { priority: { run: 'unknownVar == "high" ? 100 : 50' } },
        appointmentPayload
      )
    ).toThrow('Invalid identifier "unknownVar" in priority.run CEL expression');
  });
});

describe("rewriteInngestOptions refusals", () => {
  it("refuses batchEvents, which no listener can honour", () => {
    expect(() =>
      rewriteInngestOptions(
        "app/batched",
        // @ts-expect-error batchEvents is not a member; a spread is how one arrives.
        { batchEvents: { maxSize: 10, timeout: "5s" } },
        appointmentPayload
      )
    ).toThrow('Event "app/batched" sets inngest.batchEvents');
  });

  it("refuses Inngest concurrency, which the Lifecycle Node owns", () => {
    expect(() =>
      rewriteInngestOptions(
        "app/concurrent",
        // @ts-expect-error concurrency is not a member; a spread is how one arrives.
        { concurrency: { limit: 1, key: "appointment.id" } },
        appointmentPayload
      )
    ).toThrow('Event "app/concurrent" sets inngest.concurrency');
  });
});
