import { getValueByPath } from "@/shared/utils/object-path";
import type { WorkflowTriggerDefinition } from "@/shared/workflow/trigger-registry";
import { asNonEmptyString } from "@/shared/workflow/webhook-routing";

function evaluateDefaultRouting(
  payload: Record<string, unknown>,
  triggerType: string
) {
  const eventType = asNonEmptyString(getValueByPath(payload, "event"));
  const correlationKey = asNonEmptyString(getValueByPath(payload, "data.id"));

  return {
    triggerType,
    executionType: "manual" as const,
    eventType,
    correlationKey,
    routingDecision: { kind: "start" as const },
  };
}

export function createDefaultTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    type: "Trigger",
    label: "Trigger",
    executionType: "manual",
    evaluate(input) {
      return evaluateDefaultRouting(input.payload, "Trigger");
    },
  };
}

export function createUnknownTriggerDefinition(
  triggerType: string
): WorkflowTriggerDefinition {
  return {
    type: triggerType,
    label: triggerType,
    executionType: "manual",
    evaluate(input) {
      return evaluateDefaultRouting(input.payload, triggerType);
    },
  };
}
