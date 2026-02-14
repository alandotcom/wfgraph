import {
  createDefaultTriggerDefinition,
  createUnknownTriggerDefinition,
} from "@/shared/workflow/triggers/fallback-trigger";
import { createScheduleTriggerDefinition } from "@/shared/workflow/triggers/schedule-trigger";
import { createWebhookTriggerDefinition } from "@/shared/workflow/triggers/webhook-trigger";
import { asNonEmptyString } from "@/shared/workflow/webhook-routing";

export type TriggerExecutionType = "manual" | "webhook";

export type TriggerRoutingDecision =
  | { kind: "start" }
  | { kind: "restart" }
  | { kind: "stop" }
  | { kind: "ignore"; reason: "missing_event_type" | "event_not_configured" };

export type TriggerEvaluation = {
  triggerType: string;
  executionType: TriggerExecutionType;
  eventType: string | undefined;
  correlationKey: string | undefined;
  routingDecision: TriggerRoutingDecision;
  metadata?: {
    eventTypePath?: string;
    correlationPath?: string;
  };
};

export type WorkflowTriggerDefinition = {
  type: string;
  label: string;
  executionType: TriggerExecutionType;
  parseMockInput?: (
    config: Record<string, unknown> | undefined
  ) => Record<string, unknown> | undefined;
  evaluate: (input: {
    config: Record<string, unknown> | undefined;
    payload: Record<string, unknown>;
  }) => TriggerEvaluation;
};

export function createTrigger(
  definition: WorkflowTriggerDefinition
): WorkflowTriggerDefinition {
  return definition;
}

const defaultTrigger = createTrigger(createDefaultTriggerDefinition());
const scheduleTrigger = createTrigger(createScheduleTriggerDefinition());

const webhookTrigger = createTrigger(createWebhookTriggerDefinition());

const triggerRegistry = new Map<string, WorkflowTriggerDefinition>([
  [webhookTrigger.type, webhookTrigger],
  [scheduleTrigger.type, scheduleTrigger],
]);

export function registerWorkflowTrigger(definition: WorkflowTriggerDefinition) {
  triggerRegistry.set(definition.type, definition);
}

export function resolveWorkflowTriggerDefinition(
  config: Record<string, unknown> | undefined
): WorkflowTriggerDefinition {
  const triggerType = asNonEmptyString(config?.triggerType);

  if (!triggerType) {
    return defaultTrigger;
  }

  return (
    triggerRegistry.get(triggerType) ??
    createTrigger(createUnknownTriggerDefinition(triggerType))
  );
}

export function evaluateWorkflowTrigger(input: {
  config: Record<string, unknown> | undefined;
  payload: Record<string, unknown>;
}): TriggerEvaluation {
  const trigger = resolveWorkflowTriggerDefinition(input.config);
  return trigger.evaluate(input);
}
