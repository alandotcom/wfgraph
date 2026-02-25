import { getValueByPath, parseCsvSet } from "@/utils/object-path";
import {
  type WebhookTriggerConfigInput,
  webhookTriggerConfigSchema,
} from "@/workflow/schemas";

export const DEFAULT_WEBHOOK_EVENT_PATH = "event";
export const DEFAULT_WEBHOOK_CORRELATION_PATH = "data.id";
export const DEFAULT_WEBHOOK_CREATE_EVENTS = "event.create";
export const DEFAULT_WEBHOOK_UPDATE_EVENTS = "event.update";
export const DEFAULT_WEBHOOK_DELETE_EVENTS = "event.delete";

export type WebhookRoutingConfig = {
  eventTypePath: string;
  correlationPath: string;
  createEvents: Set<string>;
  updateEvents: Set<string>;
  deleteEvents: Set<string>;
  routingConfigured: boolean;
};

export type WebhookRoutingDecision =
  | {
      kind: "create";
    }
  | {
      kind: "update";
    }
  | {
      kind: "delete";
    }
  | {
      kind: "ignore";
      reason: "missing_event_type" | "event_not_configured";
    };

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  return trimmed;
}

function parseWebhookConfig(
  value: unknown
): WebhookTriggerConfigInput | undefined {
  const parsed = webhookTriggerConfigSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }

  return parsed.data;
}

export function buildWebhookRoutingConfig(
  config: unknown
): WebhookRoutingConfig {
  const webhookConfig = parseWebhookConfig(config);

  const createEvents = parseCsvSet(
    webhookConfig?.webhookCreateEvents ?? DEFAULT_WEBHOOK_CREATE_EVENTS
  );
  const updateEvents = parseCsvSet(
    webhookConfig?.webhookUpdateEvents ?? DEFAULT_WEBHOOK_UPDATE_EVENTS
  );
  const deleteEvents = parseCsvSet(
    webhookConfig?.webhookDeleteEvents ?? DEFAULT_WEBHOOK_DELETE_EVENTS
  );

  return {
    eventTypePath:
      asNonEmptyString(webhookConfig?.webhookEventPath) ??
      DEFAULT_WEBHOOK_EVENT_PATH,
    correlationPath:
      asNonEmptyString(webhookConfig?.webhookCorrelationPath) ??
      DEFAULT_WEBHOOK_CORRELATION_PATH,
    createEvents,
    updateEvents,
    deleteEvents,
    routingConfigured:
      createEvents.size > 0 || updateEvents.size > 0 || deleteEvents.size > 0,
  };
}

export function deriveWebhookEventContext(
  payload: Record<string, unknown>,
  routing: WebhookRoutingConfig
): { eventType: string | undefined; correlationKey: string | undefined } {
  return {
    eventType: asNonEmptyString(getValueByPath(payload, routing.eventTypePath)),
    correlationKey: asNonEmptyString(
      getValueByPath(payload, routing.correlationPath)
    ),
  };
}

export function routeWebhookEvent(input: {
  eventType: string | undefined;
  routing: WebhookRoutingConfig;
}): WebhookRoutingDecision {
  const { eventType, routing } = input;

  if (routing.routingConfigured && !eventType) {
    return { kind: "ignore", reason: "missing_event_type" };
  }

  if (eventType && routing.deleteEvents.has(eventType)) {
    return { kind: "delete" };
  }

  if (eventType && routing.updateEvents.has(eventType)) {
    return { kind: "update" };
  }

  if (
    eventType &&
    routing.createEvents.size > 0 &&
    !routing.createEvents.has(eventType)
  ) {
    return { kind: "ignore", reason: "event_not_configured" };
  }

  return { kind: "create" };
}
