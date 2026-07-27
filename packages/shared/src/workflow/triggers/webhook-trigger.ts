import { z } from "zod";
import type {
  TriggerEvaluation,
  TriggerRoutingDecision,
  WorkflowTriggerDefinition,
} from "@/workflow/trigger-registry";
import {
  asNonEmptyString,
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
  type WebhookRoutingConfig,
  type WebhookRoutingDecision,
} from "@/workflow/webhook-routing";

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

/**
 * The stored mock payload has to be a JSON object to stand in for a request
 * body, so anything else the user typed (an array, a bare string, `null`) is
 * treated as absent.
 */
const mockRequestSchema = z.record(z.string(), z.unknown());

export function parseWebhookMockInput(
  config: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const mockInputRaw = asNonEmptyString(config?.webhookMockRequest);
  if (!mockInputRaw) {
    return undefined;
  }

  try {
    const parsed = mockRequestSchema.safeParse(JSON.parse(mockInputRaw));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    return undefined;
  }

  return undefined;
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
