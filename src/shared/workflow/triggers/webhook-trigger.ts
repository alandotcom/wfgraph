import type {
  TriggerEvaluation,
  TriggerRoutingDecision,
  WorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import {
  asNonEmptyString,
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
  type WebhookRoutingConfig,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWebhookMockInput(
  config: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const mockInputRaw = asNonEmptyString(config?.webhookMockRequest);
  if (!mockInputRaw) {
    return;
  }

  try {
    const parsed = JSON.parse(mockInputRaw);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return;
  }

  return;
}

export function resolveWebhookTriggerRuntimeConfig(
  config: Record<string, unknown> | undefined
): {
  routing: WebhookRoutingConfig;
  mockInput: Record<string, unknown> | undefined;
} {
  return {
    routing: buildWebhookRoutingConfig(config),
    mockInput: parseWebhookMockInput(config),
  };
}

function toTriggerEvaluation(input: {
  decision: WebhookRoutingDecision;
  eventType: string | undefined;
  correlationKey: string | undefined;
}): TriggerEvaluation {
  return {
    eventType: input.eventType,
    correlationKey: input.correlationKey,
    routingDecision: mapWebhookDecisionToTriggerDecision(input.decision),
  };
}

export function createWebhookTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Webhook",
      executionType: "webhook",
      evaluate(input) {
        const { routing } = resolveWebhookTriggerRuntimeConfig(input.config);
        const context = deriveWebhookEventContext(input.payload, routing);
        const webhookDecision = routeWebhookEvent({
          eventType: context.eventType,
          routing,
        });

        return toTriggerEvaluation({
          decision: webhookDecision,
          eventType: context.eventType,
          correlationKey: context.correlationKey,
        });
      },
    },
    ui: {
      label: "Webhook",
    },
  };
}
