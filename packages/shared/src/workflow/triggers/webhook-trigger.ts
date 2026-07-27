import { type JsonObject, jsonObjectSchema } from "@/types/json";
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
 * Reads the mock request body a user typed into the trigger's editor, stored as
 * a JSON string in `webhookMockRequest`.
 *
 * A mock request stands in for the body a real webhook would deliver, so its
 * contents belong to whichever service the workflow listens to and no field is
 * known here. What is known is the shape: a JSON object, with JSON at every
 * depth below it, which is what `jsonObjectSchema` describes and what a caller
 * gets back. Anything else the editor accepted (an array, a bare string,
 * `null`, unparseable text) is treated as no mock at all.
 */
export function parseWebhookMockInput(
  config: Record<string, unknown> | undefined
): JsonObject | undefined {
  const mockInputRaw = asNonEmptyString(config?.webhookMockRequest);
  if (!mockInputRaw) {
    return undefined;
  }

  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(mockInputRaw));
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
  mockInput: JsonObject | undefined;
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
