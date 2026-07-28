import { type JsonObject, jsonObjectSchema } from "#src/types/json";
import type { WorkflowTriggerDefinition } from "#src/workflow/trigger-registry";
import {
  asNonEmptyString,
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  type WebhookRoutingConfig,
} from "#src/workflow/webhook-routing";

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

/**
 * The webhook trigger classifies payloads by the builder-configured paths; it
 * never validates against a schema (the builder's request schema is editor
 * guidance, and the sending service is outside the builder's control), so
 * classification always succeeds. Routing is the workflow's Routing Policy,
 * resolved by the caller.
 */
export function createWebhookTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Webhook",
      executionType: "webhook",
      evaluate(input) {
        const { routing } = resolveWebhookTriggerRuntimeConfig(input.config);
        const context = deriveWebhookEventContext(input.payload, routing);

        return {
          ok: true,
          eventType: context.eventType,
          correlationKey: context.correlationKey,
        };
      },
    },
    ui: {
      label: "Webhook",
    },
  };
}
