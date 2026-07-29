import { Option, Schema } from "effect";
import type { JsonObject } from "#src/types/json";
import { rejectUnknownKeys } from "#src/types/schema";
import { getValueByPath } from "#src/utils/object-path";
import { webhookTriggerConfigSchema } from "#src/workflow/schemas";

export const DEFAULT_WEBHOOK_EVENT_PATH = "event";
export const DEFAULT_WEBHOOK_CORRELATION_PATH = "data.id";

/**
 * The webhook trigger has no Trigger Author, so the Workflow Builder supplies
 * the classification paths that a custom trigger's definition would carry:
 * where in the payload the Event Type and the Correlation Key live. Routing
 * itself is the workflow's Routing Policy, resolved by the caller.
 */
export type WebhookRoutingConfig = {
  eventTypePath: string;
  correlationPath: string;
};

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

/**
 * A config this schema does not recognise counts as no config: the defaults
 * below are what a webhook trigger routes by when nobody said otherwise, and a
 * half-read config would route by a mix of the two.
 */
const readWebhookConfig = Schema.decodeUnknownOption(
  webhookTriggerConfigSchema,
  rejectUnknownKeys
);

export function buildWebhookRoutingConfig(
  config: unknown
): WebhookRoutingConfig {
  const webhookConfig = Option.getOrUndefined(readWebhookConfig(config));

  return {
    eventTypePath:
      asNonEmptyString(webhookConfig?.webhookEventPath) ??
      DEFAULT_WEBHOOK_EVENT_PATH,
    correlationPath:
      asNonEmptyString(webhookConfig?.webhookCorrelationPath) ??
      DEFAULT_WEBHOOK_CORRELATION_PATH,
  };
}

export function deriveWebhookEventContext(
  payload: JsonObject,
  routing: WebhookRoutingConfig
): { eventType: string | undefined; correlationKey: string | undefined } {
  return {
    eventType: asNonEmptyString(getValueByPath(payload, routing.eventTypePath)),
    correlationKey: asNonEmptyString(
      getValueByPath(payload, routing.correlationPath)
    ),
  };
}
