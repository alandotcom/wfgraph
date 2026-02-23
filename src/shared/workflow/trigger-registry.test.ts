import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createTrigger,
  evaluateWorkflowTrigger,
  listCustomWorkflowTriggers,
  registerWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
  unregisterWorkflowTrigger,
} from "./trigger-registry";

describe("createTrigger typing", () => {
  it("types lifecycle payload from schema values", () => {
    createTrigger({
      type: "TypedAppointmentTrigger",
      label: "Typed Appointment Trigger",
      schema: z.object({
        event: z.enum([
          "appointment.created",
          "appointment.rescheduled",
          "appointment.canceled",
        ]),
        appointment: z.object({ id: z.string() }),
      }),
      correlationIdPath: "appointment.id",
      lifecycle: {
        onStart: ({ payload }) => payload.event === "appointment.created",
        onRestart: ({ payload }) => payload.event === "appointment.rescheduled",
        onStop: ({ payload }) => payload.event === "appointment.canceled",
      },
    });

    createTrigger({
      type: "TypedAppointmentTriggerInvalid",
      label: "Typed Appointment Trigger Invalid",
      schema: z.object({
        event: z.enum([
          "appointment.created",
          "appointment.rescheduled",
          "appointment.canceled",
        ]),
        appointment: z.object({ id: z.string() }),
      }),
      correlationIdPath: "appointment.id",
      lifecycle: {
        onStart: ({ payload }) => {
          // @ts-expect-error payload.event does not include "appointment.invalid".
          const invalidEvent: "appointment.invalid" = payload.event;
          return invalidEvent === "appointment.invalid";
        },
        onRestart: () => false,
        onStop: () => false,
      },
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

describe("evaluateWorkflowTrigger", () => {
  it("evaluates webhook event routing", () => {
    const evaluation = evaluateWorkflowTrigger({
      config: {
        triggerType: "Webhook",
      },
      payload: {
        event: "event.delete",
        data: { id: "abc-123" },
      },
    });

    expect(evaluation.eventType).toBe("event.delete");
    expect(evaluation.correlationKey).toBe("abc-123");
    expect(evaluation.routingDecision).toEqual({ kind: "stop" });
  });

  it("falls back to start for unknown custom trigger types", () => {
    const evaluation = evaluateWorkflowTrigger({
      config: {
        triggerType: "Stripe",
      },
      payload: {
        event: "invoice.created",
        data: { id: "in_123" },
      },
    });

    expect(evaluation.eventType).toBe("invoice.created");
    expect(evaluation.correlationKey).toBe("in_123");
    expect(evaluation.routingDecision).toEqual({ kind: "start" });
  });
});

describe("registerWorkflowTrigger", () => {
  it("supports registering a strict-schema custom trigger", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "InternalQueue",
        label: "Internal Queue",
        schema: z.object({
          event: z.string(),
          job: z.object({ id: z.string() }),
        }),
        correlationIdPath: "job.id",
        lifecycle: {
          onStart: ({ payload }) =>
            payload.event === "job.ready" || payload.event === "job.created",
          onRestart: () => false,
          onStop: () => false,
        },
      })
    );

    const evaluation = evaluateWorkflowTrigger({
      config: { triggerType: "InternalQueue" },
      payload: { event: "job.ready", job: { id: "job_123" } },
    });

    expect(evaluation.eventType).toBeUndefined();
    expect(evaluation.correlationKey).toBe("job_123");
    expect(evaluation.routingDecision).toEqual({ kind: "start" });
  });

  it("ignores payloads that fail strict schema validation", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "StrictPayloadTrigger",
        label: "Strict Payload Trigger",
        schema: z.object({
          event: z.string(),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: ({ payload }) => payload.event === "entity.created",
          onRestart: () => false,
          onStop: () => false,
        },
      })
    );

    const evaluation = evaluateWorkflowTrigger({
      config: { triggerType: "StrictPayloadTrigger" },
      payload: { event: "entity.created" },
    });

    expect(evaluation.routingDecision).toEqual({
      kind: "ignore",
      reason: "event_not_configured",
    });
  });

  it("surfaces lifecycle callback failures instead of silently ignoring them", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "FailingLifecycleTrigger",
        label: "Failing Lifecycle Trigger",
        schema: z.object({
          event: z.string(),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: () => {
            throw new Error("boom");
          },
          onRestart: () => false,
          onStop: () => false,
        },
      })
    );

    expect(() =>
      evaluateWorkflowTrigger({
        config: { triggerType: "FailingLifecycleTrigger" },
        payload: { event: "entity.created", entity: { id: "ent_1" } },
      })
    ).toThrow('Trigger "FailingLifecycleTrigger" lifecycle.start failed: boom');
  });

  it("includes custom trigger metadata for editor rendering", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "CustomWebhookRouter",
        label: "Custom Webhook Router",
        description: "Routes webhook payloads from a custom source.",
        logoUrl: "https://cdn.example.com/logos/custom-router.svg",
        schema: z.object({
          event: z.enum(["entity.created", "entity.updated", "entity.deleted"]),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: ({ payload }) => payload.event === "entity.created",
          onRestart: ({ payload }) => payload.event === "entity.updated",
          onStop: ({ payload }) => payload.event === "entity.deleted",
        },
        configFields: [
          {
            key: "eventPath",
            label: "Event Path",
            type: "text",
            required: true,
            placeholder: "event.name",
          },
        ],
      })
    );

    const customTriggers = listCustomWorkflowTriggers();
    const triggerMetadata = customTriggers.find(
      (trigger) => trigger.type === "CustomWebhookRouter"
    );

    expect(triggerMetadata).toBeDefined();
    expect(triggerMetadata?.label).toBe("Custom Webhook Router");
    expect(triggerMetadata?.description).toBe(
      "Routes webhook payloads from a custom source."
    );
    expect(triggerMetadata?.logoUrl).toBe(
      "https://cdn.example.com/logos/custom-router.svg"
    );
    expect(triggerMetadata?.executionType).toBe("webhook");
    expect(triggerMetadata?.configFields).toHaveLength(1);
    const firstField = triggerMetadata?.configFields?.[0];
    expect(firstField && "key" in firstField ? firstField.key : undefined).toBe(
      "eventPath"
    );
  });

  it("sets executionType to 'event' and builds inngestEventTrigger for single event", () => {
    const trigger = createTrigger({
      type: "SingleEventTrigger",
      label: "Single Event Trigger",
      event: "app/order.created",
      schema: z.object({
        event: z.string(),
        order: z.object({ id: z.string() }),
      }),
      correlationIdPath: "order.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.executionType).toBe("event");
    expect(trigger.runtime.inngestEventTrigger).toBeDefined();
    expect(trigger.runtime.inngestEventTrigger?.eventNames).toEqual([
      "app/order.created",
    ]);
    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({});

    unregisterWorkflowTrigger("SingleEventTrigger");
  });

  it("sets executionType to 'event' and builds inngestEventTrigger for multiple events", () => {
    const trigger = createTrigger({
      type: "MultiEventTrigger",
      label: "Multi Event Trigger",
      event: ["app/order.created", "app/order.updated"],
      schema: z.object({
        event: z.string(),
        order: z.object({ id: z.string() }),
      }),
      correlationIdPath: "order.id",
      lifecycle: {
        onStart: ({ payload }) => payload.event === "order.created",
        onRestart: ({ payload }) => payload.event === "order.updated",
        onStop: () => false,
      },
    });

    expect(trigger.runtime.executionType).toBe("event");
    expect(trigger.runtime.inngestEventTrigger?.eventNames).toEqual([
      "app/order.created",
      "app/order.updated",
    ]);

    unregisterWorkflowTrigger("MultiEventTrigger");
  });

  it("passes idempotency and concurrency into functionOptions", () => {
    const trigger = createTrigger({
      type: "IdempotentEventTrigger",
      label: "Idempotent Event Trigger",
      event: "app/payment.received",
      idempotency: "event.data.paymentId",
      concurrency: { limit: 1, key: "event.data.accountId" },
      schema: z.object({
        event: z.string(),
        data: z.object({ id: z.string() }),
      }),
      correlationIdPath: "data.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      idempotency: "event.data.paymentId",
      concurrency: { limit: 1, key: "event.data.accountId" },
    });

    unregisterWorkflowTrigger("IdempotentEventTrigger");
  });

  it("merges inngest function options into functionOptions", () => {
    const trigger = createTrigger({
      type: "ThrottledEventTrigger",
      label: "Throttled Event Trigger",
      event: "app/notification.sent",
      inngest: {
        rateLimit: { limit: 10, period: "1m" },
        retries: 3,
      },
      schema: z.object({
        event: z.string(),
        notification: z.object({ id: z.string() }),
      }),
      correlationIdPath: "notification.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      rateLimit: { limit: 10, period: "1m" },
      retries: 3,
    });

    unregisterWorkflowTrigger("ThrottledEventTrigger");
  });

  it("throws when event name is empty string", () => {
    expect(() =>
      createTrigger({
        type: "EmptyEventTrigger",
        label: "Empty Event Trigger",
        event: "",
        schema: z.object({
          event: z.string(),
          data: z.object({ id: z.string() }),
        }),
        correlationIdPath: "data.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow("Trigger event names must be non-empty strings");
  });

  it("throws when event array contains empty string", () => {
    expect(() =>
      createTrigger({
        type: "EmptyArrayEventTrigger",
        label: "Empty Array Event Trigger",
        event: ["app/valid.event", "  "],
        schema: z.object({
          event: z.string(),
          data: z.object({ id: z.string() }),
        }),
        correlationIdPath: "data.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow("Trigger event names must be non-empty strings");
  });

  it("throws when inngest options include batchEvents", () => {
    expect(() =>
      createTrigger({
        type: "BatchEventTrigger",
        label: "Batch Event Trigger",
        event: "app/batch.event",
        inngest: {
          batchEvents: { maxSize: 10, timeout: "5s" },
        } as Record<string, unknown>,
        schema: z.object({
          event: z.string(),
          data: z.object({ id: z.string() }),
        }),
        correlationIdPath: "data.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow("batchEvents is not supported");
  });

  it("trims whitespace from event names", () => {
    const trigger = createTrigger({
      type: "WhitespaceEventTrigger",
      label: "Whitespace Event Trigger",
      event: "  app/trimmed.event  ",
      schema: z.object({
        event: z.string(),
        data: z.object({ id: z.string() }),
      }),
      correlationIdPath: "data.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.eventNames).toEqual([
      "app/trimmed.event",
    ]);

    unregisterWorkflowTrigger("WhitespaceEventTrigger");
  });

  it("sets executionType to 'webhook' when event is not provided", () => {
    const trigger = createTrigger({
      type: "NoEventWebhookTrigger",
      label: "No Event Webhook Trigger",
      schema: z.object({
        event: z.string(),
        data: z.object({ id: z.string() }),
      }),
      correlationIdPath: "data.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.executionType).toBe("webhook");
    expect(trigger.runtime.inngestEventTrigger).toBeUndefined();

    unregisterWorkflowTrigger("NoEventWebhookTrigger");
  });

  it("supports unregistering custom trigger types while keeping built-ins", () => {
    const ephemeralTrigger = createTrigger({
      type: "EphemeralRuntimeTrigger",
      label: "Ephemeral Runtime Trigger",
      schema: z.object({
        event: z.string(),
        data: z.object({ id: z.string() }),
      }),
      correlationIdPath: "data.id",
      lifecycle: {
        onStart: ({ payload }) => payload.event === "entity.created",
        onRestart: () => false,
        onStop: () => false,
      },
    });

    registerWorkflowTrigger(ephemeralTrigger);
    expect(
      listCustomWorkflowTriggers().some(
        (trigger) => trigger.type === "EphemeralRuntimeTrigger"
      )
    ).toBe(true);

    expect(() => registerWorkflowTrigger(ephemeralTrigger)).toThrow(
      'Trigger type "EphemeralRuntimeTrigger" is already registered'
    );

    unregisterWorkflowTrigger("EphemeralRuntimeTrigger");
    expect(
      listCustomWorkflowTriggers().some(
        (trigger) => trigger.type === "EphemeralRuntimeTrigger"
      )
    ).toBe(false);

    unregisterWorkflowTrigger("Webhook");
    const webhook = resolveWorkflowTriggerDefinition({
      triggerType: "Webhook",
    });
    expect(webhook.runtime.type).toBe("Webhook");
  });
});
