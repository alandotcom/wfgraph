import { describe, expect, it } from "bun:test";
import {
  createTrigger,
  evaluateWorkflowTrigger,
  listCustomWorkflowTriggers,
  registerWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "./trigger-registry";

describe("resolveWorkflowTriggerDefinition", () => {
  it("falls back to default trigger when config is missing", () => {
    const trigger = resolveWorkflowTriggerDefinition(undefined);

    expect(trigger.type).toBe("Trigger");
    expect(trigger.executionType).toBe("manual");
  });

  it("resolves the webhook trigger definition", () => {
    const trigger = resolveWorkflowTriggerDefinition({
      triggerType: "Webhook",
    });

    expect(trigger.type).toBe("Webhook");
    expect(trigger.executionType).toBe("webhook");
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

    expect(evaluation.executionType).toBe("webhook");
    expect(evaluation.eventType).toBe("event.delete");
    expect(evaluation.correlationKey).toBe("abc-123");
    expect(evaluation.routingDecision).toEqual({ kind: "stop" });
    expect(evaluation.metadata?.eventTypePath).toBe("event");
    expect(evaluation.metadata?.correlationPath).toBe("data.id");
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

    expect(evaluation.triggerType).toBe("Stripe");
    expect(evaluation.executionType).toBe("manual");
    expect(evaluation.eventType).toBe("invoice.created");
    expect(evaluation.correlationKey).toBe("in_123");
    expect(evaluation.routingDecision).toEqual({ kind: "start" });
  });
});

describe("registerWorkflowTrigger", () => {
  it("supports registering a custom trigger definition via createTrigger", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "InternalQueue",
        label: "Internal Queue",
        executionType: "manual",
        evaluate(input) {
          const eventType =
            typeof input.payload.kind === "string" ? input.payload.kind : "job";

          return {
            triggerType: "InternalQueue",
            executionType: "manual",
            eventType,
            correlationKey: undefined,
            routingDecision: { kind: "start" },
          };
        },
      })
    );

    const evaluation = evaluateWorkflowTrigger({
      config: { triggerType: "InternalQueue" },
      payload: { kind: "job.ready" },
    });

    expect(evaluation.triggerType).toBe("InternalQueue");
    expect(evaluation.eventType).toBe("job.ready");
  });

  it("includes custom trigger metadata for editor rendering", () => {
    registerWorkflowTrigger(
      createTrigger({
        type: "CustomWebhookRouter",
        label: "Custom Webhook Router",
        description: "Routes webhook payloads from a custom source.",
        logoUrl: "https://cdn.example.com/logos/custom-router.svg",
        executionType: "webhook",
        configFields: [
          {
            key: "eventPath",
            label: "Event Path",
            type: "text",
            required: true,
            placeholder: "event.name",
          },
        ],
        evaluate() {
          return {
            triggerType: "CustomWebhookRouter",
            executionType: "webhook",
            eventType: undefined,
            correlationKey: undefined,
            routingDecision: { kind: "start" },
          };
        },
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
    expect(triggerMetadata?.configFields).toHaveLength(1);
    const firstField = triggerMetadata?.configFields?.[0];
    expect(firstField && "key" in firstField ? firstField.key : undefined).toBe(
      "eventPath"
    );
  });
});
