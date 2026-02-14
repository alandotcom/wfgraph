import type {
  TriggerRoutingDecision,
  WorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import {
  asNonEmptyString,
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
} from "@/shared/workflow/webhook-routing";

export function createWebhookTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    type: "Webhook",
    label: "Webhook",
    executionType: "webhook",
    parseMockInput(config) {
      const mockInputRaw = asNonEmptyString(config?.webhookMockRequest);
      if (!mockInputRaw) {
        return;
      }

      try {
        const parsed = JSON.parse(mockInputRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return;
      }

      return;
    },
    evaluate(input) {
      const routing = buildWebhookRoutingConfig(input.config);
      const context = deriveWebhookEventContext(input.payload, routing);
      const webhookDecision = routeWebhookEvent({
        eventType: context.eventType,
        routing,
      });
      let routingDecision: TriggerRoutingDecision;

      if (webhookDecision.kind === "create") {
        routingDecision = { kind: "start" };
      } else if (webhookDecision.kind === "update") {
        routingDecision = { kind: "restart" };
      } else if (webhookDecision.kind === "delete") {
        routingDecision = { kind: "stop" };
      } else {
        routingDecision = {
          kind: "ignore",
          reason: webhookDecision.reason,
        };
      }

      return {
        triggerType: "Webhook",
        executionType: "webhook",
        eventType: context.eventType,
        correlationKey: context.correlationKey,
        routingDecision,
        metadata: {
          eventTypePath: routing.eventTypePath,
          correlationPath: routing.correlationPath,
        },
      };
    },
  };
}
