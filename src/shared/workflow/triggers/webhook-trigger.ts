import type {
  TriggerRoutingDecision,
  WorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import {
  asNonEmptyString,
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
  type WebhookRoutingDecision,
} from "@/shared/workflow/webhook-routing";

function assertUnreachable(value: never): never {
  throw new Error(
    `Unhandled webhook routing decision: ${JSON.stringify(value)}`
  );
}

function mapWebhookDecisionToTriggerDecision(
  decision: WebhookRoutingDecision
): TriggerRoutingDecision {
  switch (decision.kind) {
    case "create":
      return { kind: "start" };
    case "update":
      return { kind: "restart" };
    case "delete":
      return { kind: "stop" };
    case "ignore":
      return { kind: "ignore", reason: decision.reason };
    default:
      return assertUnreachable(decision);
  }
}

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

      return {
        triggerType: "Webhook",
        executionType: "webhook",
        eventType: context.eventType,
        correlationKey: context.correlationKey,
        routingDecision: mapWebhookDecisionToTriggerDecision(webhookDecision),
        metadata: {
          eventTypePath: routing.eventTypePath,
          correlationPath: routing.correlationPath,
        },
      };
    },
  };
}
