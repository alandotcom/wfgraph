import { type JsonObject, readJsonObject } from "#src/types/json";
import { asNonEmptyString } from "#src/types/string";
import type { WorkflowTriggerDefinition } from "#src/workflow/trigger-registry";

/**
 * Reads the mock request body a user typed into the trigger's editor, stored as
 * a JSON string in `webhookMockRequest`.
 *
 * A mock request stands in for the body a real webhook would deliver, so its
 * contents belong to whichever service the workflow listens to and no field is
 * known here. What is known is the shape: a JSON object, with JSON at every
 * depth below it, which is what `readJsonObject` answers with and what a caller
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
    return readJsonObject(JSON.parse(mockInputRaw)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The webhook trigger validates nothing: the builder's request schema is editor
 * guidance, and the service doing the sending is outside the builder's control, so
 * every payload classifies. It names no Event Type or Correlation Key either --
 * which Events start a run, and where each carries its Entity Value, is the
 * Lifecycle Rules' declaration now (ADR-0007).
 */
export function createWebhookTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Webhook",
      executionType: "webhook",
      evaluate() {
        return { ok: true, eventType: undefined, correlationKey: undefined };
      },
    },
    ui: {
      label: "Webhook",
    },
  };
}
