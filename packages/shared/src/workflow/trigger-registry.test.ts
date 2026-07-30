/**
 * The fixtures here are Zod, deliberately, and Zod is a devDependency of this
 * package for no other reason. The registry takes any Standard Schema, and
 * writing these against the library the repo itself uses would leave that claim
 * untested: a schema built by Effect would only prove the registry works with
 * the shape Effect produces. `standard-schema-compat.test.ts` makes the same
 * point with arktype from the other side.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createTrigger,
  listCustomWorkflowTriggers,
  registerWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
  unregisterWorkflowTrigger,
} from "./trigger-registry";

const appointmentSchema = z.object({
  event: z.enum([
    "appointment.created",
    "appointment.rescheduled",
    "appointment.canceled",
  ]),
  appointment: z.object({ id: z.string() }),
});

describe("createTrigger typing", () => {
  it("accepts paths that resolve to strings in the payload schema", () => {
    createTrigger({
      type: "TypedAppointmentTrigger",
      label: "Typed Appointment Trigger",
      schema: appointmentSchema,
      correlationIdPath: "appointment.id",
      eventTypePath: "event",
    });
  });

  it("rejects paths that resolve to something other than a string", () => {
    createTrigger({
      type: "TypedAppointmentTriggerInvalid",
      label: "Typed Appointment Trigger Invalid",
      schema: appointmentSchema,
      // @ts-expect-error "appointment" is an object, not a string field.
      correlationIdPath: "appointment",
      eventTypePath: "event",
    });
  });
});

describe("resolveWorkflowTriggerDefinition", () => {
  it("falls back to default trigger when config is missing", () => {
    const trigger = resolveWorkflowTriggerDefinition(undefined);

    expect(trigger.runtime.type).toBe("Trigger");
    expect(trigger.runtime.executionType).toBe("manual");
  });

  it("resolves the webhook trigger definition", () => {
    const trigger = resolveWorkflowTriggerDefinition({
      triggerType: "Webhook",
    });

    expect(trigger.runtime.type).toBe("Webhook");
    expect(trigger.runtime.executionType).toBe("webhook");
  });
});

describe("createTrigger Event Type vocabulary", () => {
  it("derives eventTypes from the enum at eventTypePath", () => {
    const trigger = createTrigger({
      type: "EnumVocabularyTrigger",
      label: "Enum Vocabulary Trigger",
      schema: appointmentSchema,
      correlationIdPath: "appointment.id",
      eventTypePath: "event",
    });

    expect(trigger.ui.eventTypes).toEqual([
      "appointment.created",
      "appointment.rescheduled",
      "appointment.canceled",
    ]);
    expect(trigger.ui.correlationPath).toBe("appointment.id");
  });
});

describe("registerWorkflowTrigger", () => {
  it("derives outputFields from trigger schema", () => {
    const trigger = createTrigger({
      type: "OutputFieldsTrigger",
      label: "Output Fields Trigger",
      schema: z.object({
        donorUuid: z.string(),
        status: z.enum(["eligible", "ineligible"]),
        score: z.number(),
      }),
      correlationIdPath: "donorUuid",
      eventTypePath: "status",
    });

    expect(trigger.ui.outputFields).toBeDefined();
    expect(trigger.ui.outputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "donorUuid" }),
        expect.objectContaining({ path: "status" }),
        expect.objectContaining({ path: "score" }),
      ])
    );

    unregisterWorkflowTrigger("OutputFieldsTrigger");
  });

  it("includes outputFields in listCustomWorkflowTriggers metadata", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "MetadataOutputTrigger",
        label: "Metadata Output Trigger",
        schema: z.object({
          entityId: z.string(),
          active: z.boolean(),
        }),
        correlationIdPath: "entityId",
        eventTypePath: "entityId",
      })
    );

    const customTriggers = listCustomWorkflowTriggers();
    const metadata = customTriggers.find(
      (t) => t.type === "MetadataOutputTrigger"
    );

    expect(metadata).toBeDefined();
    expect(metadata?.outputFields).toBeDefined();
    expect(metadata?.outputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "entityId" }),
        expect.objectContaining({ path: "active" }),
      ])
    );

    unregisterWorkflowTrigger("MetadataOutputTrigger");
  });
});
