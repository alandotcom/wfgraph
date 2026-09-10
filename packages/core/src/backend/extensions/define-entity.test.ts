import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineEntity,
  EntityStateRejected,
} from "#src/backend/extensions/define-entity";
import {
  isoTimestampString,
  isoTimestampToDate,
} from "@wfgraph/shared/types/timestamp";

const appointmentState = Schema.Struct({
  status: Schema.Literals(["scheduled", "completed", "cancelled"]).annotate({
    description: "Current appointment status",
  }),
  startsAt: isoTimestampString("Appointment start time"),
  remindersEnabled: Schema.Boolean.annotate({
    description: "Whether reminders may be sent",
  }),
});

describe("defineEntity identity and state", () => {
  it("normalizes identity and derives the builder-visible state fields", () => {
    const entity = defineEntity({
      type: "  appointment  ",
      label: "  Appointment  ",
      state: appointmentState,
      resolve: () => null,
    });

    expect(entity.kind).toBe("entity");
    expect(entity.type).toBe("appointment");
    expect(entity.label).toBe("Appointment");
    expect(entity.stateFields).toEqual([
      {
        path: "status",
        description: "Current appointment status",
        type: "string",
        enumValues: ["scheduled", "completed", "cancelled"],
      },
      {
        path: "startsAt",
        description: "Appointment start time",
        type: "timestamp",
      },
      {
        path: "remindersEnabled",
        description: "Whether reminders may be sent",
        type: "boolean",
      },
    ]);
    expect(entity.stateSchemaDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps equivalent property declaration order out of the state schema digest", () => {
    const first = defineEntity({
      type: "first",
      label: "First",
      state: Schema.Struct({
        status: Schema.String,
        enabled: Schema.Boolean,
      }),
      resolve: () => null,
    });
    const second = defineEntity({
      type: "second",
      label: "Second",
      state: Schema.Struct({
        enabled: Schema.Boolean,
        status: Schema.String,
      }),
      resolve: () => null,
    });

    expect(first.stateSchemaDigest).toBe(second.stateSchemaDigest);
  });

  it("keeps resolver implementation identity out of the state schema digest", () => {
    const first = defineEntity({
      type: "appointment",
      label: "Appointment",
      state: appointmentState,
      resolve: () => null,
    });
    const second = defineEntity({
      type: "appointment",
      label: "Appointment",
      state: appointmentState,
      resolve: () => ({
        status: "completed" as const,
        startsAt: "2026-10-20T15:00:00.000Z",
        remindersEnabled: false,
      }),
    });

    expect(first.stateSchemaDigest).toBe(second.stateSchemaDigest);
  });

  it("refuses blank identifiers and labels", () => {
    expect(() =>
      defineEntity({
        type: "  ",
        label: "Appointment",
        state: appointmentState,
        resolve: () => null,
      })
    ).toThrow("An Entity's type must be a non-empty string");

    expect(() =>
      defineEntity({
        type: "appointment",
        label: "  ",
        state: appointmentState,
        resolve: () => null,
      })
    ).toThrow('Entity "appointment" must have a non-empty label');
  });

  it("refuses a state schema without an object root", () => {
    expect(() =>
      defineEntity({
        type: "appointment",
        label: "Appointment",
        state: Schema.Array(Schema.String),
        resolve: () => [],
      })
    ).toThrow(/root is not an object with named properties/u);
  });

  it("uses the state schema as the sole source of resolver output typing", () => {
    defineEntity({
      type: "appointment",
      label: "Appointment",
      state: appointmentState,
      // @ts-expect-error startsAt and remindersEnabled are required by state.
      resolve: () => ({ status: "scheduled" }),
    });
  });
});

describe("Entity resolution", () => {
  it("passes the named entityId to the host resolver", async () => {
    let received: string | undefined;
    const entity = defineEntity({
      type: "appointment",
      label: "Appointment",
      state: appointmentState,
      resolve: ({ entityId }) => {
        received = entityId;
        return null;
      },
    });

    await expect(entity.resolve({ entityId: "apt_123" })).resolves.toBeNull();
    expect(received).toBe("apt_123");
  });

  it("encodes Effect state through its canonical JSON codec", async () => {
    const entity = defineEntity({
      type: "appointment-observation",
      label: "Appointment observation",
      state: Schema.Struct({ observedAt: isoTimestampToDate }),
      resolve: () => ({
        observedAt: new Date("2026-10-20T15:00:00.000Z"),
      }),
    });

    await expect(entity.resolve({ entityId: "apt_123" })).resolves.toEqual({
      observedAt: "2026-10-20T15:00:00.000Z",
    });
  });

  it("rejects transformed foreign schemas because validation has no encoder", () => {
    const transformed = z.object({
      status: z.string().transform((status) => status.length),
    });

    defineEntity({
      type: "transformed",
      label: "Transformed",
      // @ts-expect-error Foreign Entity schemas must validate the same JSON shape the resolver returns.
      state: transformed,
      resolve: () => ({ status: 3 }),
    });
  });

  it("validates foreign Standard Schema state and keeps its parsed object", async () => {
    const entity = defineEntity({
      type: "appointment",
      label: "Appointment",
      state: z.object({ status: z.string() }),
      resolve: () => ({ status: "scheduled", internal: "discard me" }),
    });

    await expect(entity.resolve({ entityId: "apt_123" })).resolves.toEqual({
      status: "scheduled",
    });
  });

  it("rejects malformed host state without quoting the returned value", async () => {
    const entity = defineEntity({
      type: "appointment",
      label: "Appointment",
      state: appointmentState,
      resolve: () =>
        ({
          status: "SECRET_BAD_STATUS",
          startsAt: "2026-10-20T15:00:00.000Z",
          remindersEnabled: true,
        }) as never,
    });

    const resolution = entity.resolve({ entityId: "apt_123" });
    await expect(resolution).rejects.toBeInstanceOf(EntityStateRejected);
    await expect(resolution).rejects.not.toThrow("SECRET_BAD_STATUS");
  });
});
