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
        configSchema: z.object({
          eventPath: z.string().describe("Event Path"),
        }),
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
    expect(
      firstField && "label" in firstField ? firstField.label : undefined
    ).toBe("Event Path");
    expect(
      firstField && "type" in firstField ? firstField.type : undefined
    ).toBe("template-input");
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

  it("passes concurrency into functionOptions with event.data prefix", () => {
    const trigger = createTrigger({
      type: "ConcurrentEventTrigger",
      label: "Concurrent Event Trigger",
      event: "app/payment.received",
      concurrency: { limit: 1, key: "payment.id" },
      schema: z.object({
        event: z.string(),
        payment: z.object({ id: z.string() }),
      }),
      correlationIdPath: "payment.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      concurrency: { limit: 1, key: "event.data.payment.id" },
    });

    unregisterWorkflowTrigger("ConcurrentEventTrigger");
  });

  it("throws when concurrency is set on both the trigger and inngest options", () => {
    expect(() =>
      createTrigger({
        type: "ConflictConcurrencyTrigger",
        label: "Conflict Concurrency Trigger",
        event: "app/conflict.event",
        concurrency: { limit: 1, key: "entity.id" },
        inngest: {
          concurrency: { limit: 2, key: "event.data.entity.id" },
        } as never,
        schema: z.object({
          event: z.string(),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow(
      "concurrency cannot be set on both the trigger and inngest options"
    );
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

  it("prefixes inngest.rateLimit.key with event.data.", () => {
    const trigger = createTrigger({
      type: "RateLimitKeyTrigger",
      label: "Rate Limit Key Trigger",
      event: "app/rate.limited",
      inngest: {
        rateLimit: { limit: 5, period: "1m", key: "entity.id" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      rateLimit: { limit: 5, period: "1m", key: "event.data.entity.id" },
    });

    unregisterWorkflowTrigger("RateLimitKeyTrigger");
  });

  it("prefixes inngest.throttle.key with event.data.", () => {
    const trigger = createTrigger({
      type: "ThrottleKeyTrigger",
      label: "Throttle Key Trigger",
      event: "app/throttled",
      inngest: {
        throttle: { limit: 10, period: "1h", key: "entity.id" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      throttle: { limit: 10, period: "1h", key: "event.data.entity.id" },
    });

    unregisterWorkflowTrigger("ThrottleKeyTrigger");
  });

  it("rewrites priority.run CEL identifiers with event.data. prefix", () => {
    const trigger = createTrigger({
      type: "PriorityRunTrigger",
      label: "Priority Run Trigger",
      event: "app/priority.event",
      inngest: {
        priority: { run: 'appointment.priority == "high" ? 100 : 50' },
      },
      schema: z.object({
        event: z.string(),
        appointment: z.object({
          id: z.string(),
          priority: z.string(),
        }),
      }),
      correlationIdPath: "appointment.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      priority: {
        run: 'event.data.appointment.priority == "high" ? 100 : 50',
      },
    });

    unregisterWorkflowTrigger("PriorityRunTrigger");
  });

  it("throws when priority.run contains invalid identifiers", () => {
    expect(() =>
      createTrigger({
        type: "InvalidPriorityTrigger",
        label: "Invalid Priority Trigger",
        event: "app/invalid.priority",
        inngest: {
          priority: { run: 'unknownVar == "high" ? 100 : 50' },
        },
        schema: z.object({
          event: z.string(),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow('Invalid identifier "unknownVar" in priority.run CEL expression');
  });

  it("passes concurrency as a plain number without key prefixing", () => {
    const trigger = createTrigger({
      type: "NumericConcurrencyTrigger",
      label: "Numeric Concurrency Trigger",
      event: "app/numeric.concurrency",
      concurrency: 5,
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      concurrency: 5,
    });

    unregisterWorkflowTrigger("NumericConcurrencyTrigger");
  });

  it("prefixes keys in concurrency array entries", () => {
    const trigger = createTrigger({
      type: "ArrayConcurrencyTrigger",
      label: "Array Concurrency Trigger",
      event: "app/array.concurrency",
      concurrency: [
        { limit: 1, key: "entity.id", scope: "fn" },
        { limit: 5, scope: "env" },
      ],
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      concurrency: [
        { limit: 1, key: "event.data.entity.id", scope: "fn" },
        { limit: 5, scope: "env" },
      ],
    });

    unregisterWorkflowTrigger("ArrayConcurrencyTrigger");
  });

  it("prefixes inngest.debounce.key with event.data.", () => {
    const trigger = createTrigger({
      type: "DebounceKeyTrigger",
      label: "Debounce Key Trigger",
      event: "app/debounced",
      inngest: {
        debounce: { period: "5s", key: "entity.id", timeout: "1h" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      debounce: {
        period: "5s",
        key: "event.data.entity.id",
        timeout: "1h",
      },
    });

    unregisterWorkflowTrigger("DebounceKeyTrigger");
  });

  it("passes rateLimit without key unchanged (no spurious prefix)", () => {
    const trigger = createTrigger({
      type: "RateLimitNoKeyTrigger",
      label: "Rate Limit No Key Trigger",
      event: "app/rate.nokey",
      inngest: {
        rateLimit: { limit: 10, period: "1m" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      rateLimit: { limit: 10, period: "1m" },
    });

    unregisterWorkflowTrigger("RateLimitNoKeyTrigger");
  });

  it("passes inngest.timeouts through without modification", () => {
    const trigger = createTrigger({
      type: "TimeoutsTrigger",
      label: "Timeouts Trigger",
      event: "app/timeout.event",
      inngest: {
        timeouts: { start: "1h", finish: "2h" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      timeouts: { start: "1h", finish: "2h" },
    });

    unregisterWorkflowTrigger("TimeoutsTrigger");
  });

  it("passes inngest.retries through as-is", () => {
    const trigger = createTrigger({
      type: "RetriesTrigger",
      label: "Retries Trigger",
      event: "app/retry.event",
      inngest: {
        retries: 5,
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      retries: 5,
    });

    unregisterWorkflowTrigger("RetriesTrigger");
  });

  it("leaves priority.run unchanged when expression has no identifiers", () => {
    const trigger = createTrigger({
      type: "ConstantPriorityTrigger",
      label: "Constant Priority Trigger",
      event: "app/constant.priority",
      inngest: {
        priority: { run: "100" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      priority: { run: "100" },
    });

    unregisterWorkflowTrigger("ConstantPriorityTrigger");
  });

  it("rewrites multiple distinct identifiers in priority.run", () => {
    const trigger = createTrigger({
      type: "MultiIdPriorityTrigger",
      label: "Multi Id Priority Trigger",
      event: "app/multi.priority",
      inngest: {
        priority: {
          run: 'entity.priority == "high" ? 100 : (event == "urgent" ? 80 : 0)',
        },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string(), priority: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    const run = trigger.runtime.inngestEventTrigger?.functionOptions
      ?.priority as { run: string } | undefined;
    expect(run?.run).toContain("event.data.entity.priority");
    expect(run?.run).toContain("event.data.event");

    unregisterWorkflowTrigger("MultiIdPriorityTrigger");
  });

  it("throws on syntactically invalid CEL in priority.run", () => {
    expect(() =>
      createTrigger({
        type: "BadCelTrigger",
        label: "Bad CEL Trigger",
        event: "app/bad.cel",
        inngest: {
          priority: { run: "== invalid ++" },
        },
        schema: z.object({
          event: z.string(),
          entity: z.object({ id: z.string() }),
        }),
        correlationIdPath: "entity.id",
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
      })
    ).toThrow("Invalid CEL expression in priority.run");
  });

  it("combines concurrency with inngest options (non-concurrency) correctly", () => {
    const trigger = createTrigger({
      type: "CombinedOptionsTrigger",
      label: "Combined Options Trigger",
      event: "app/combined.event",
      concurrency: { limit: 3, key: "entity.id" },
      inngest: {
        rateLimit: { limit: 10, period: "1m", key: "entity.id" },
        throttle: { limit: 5, period: "30s" },
        retries: 2,
        timeouts: { finish: "5m" },
      },
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      correlationIdPath: "entity.id",
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
    });

    expect(trigger.runtime.inngestEventTrigger?.functionOptions).toEqual({
      concurrency: { limit: 3, key: "event.data.entity.id" },
      rateLimit: { limit: 10, period: "1m", key: "event.data.entity.id" },
      throttle: { limit: 5, period: "30s" },
      retries: 2,
      timeouts: { finish: "5m" },
    });

    unregisterWorkflowTrigger("CombinedOptionsTrigger");
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
        } as never,
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
      lifecycle: {
        onStart: () => true,
        onRestart: () => false,
        onStop: () => false,
      },
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
        lifecycle: {
          onStart: () => true,
          onRestart: () => false,
          onStop: () => false,
        },
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
