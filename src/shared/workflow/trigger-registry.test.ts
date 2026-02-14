import { describe, expect, it } from "bun:test";
import {
  createTrigger,
  evaluateWorkflowTrigger,
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
});
