import type { JsonObject } from "@/types/json";
import { getValueByPath } from "@/utils/object-path";
import type {
  TriggerEvaluation,
  WorkflowTriggerDefinition,
} from "@/workflow/trigger-registry";
import { asNonEmptyString } from "@/workflow/webhook-routing";

function evaluateDefaultRouting(payload: JsonObject): TriggerEvaluation {
  const eventType = asNonEmptyString(getValueByPath(payload, "event"));
  const correlationKey = asNonEmptyString(getValueByPath(payload, "data.id"));

  return {
    eventType,
    correlationKey,
    routingDecision: { kind: "start" },
  };
}

export function createDefaultTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Trigger",
      executionType: "manual",
      evaluate(input) {
        return evaluateDefaultRouting(input.payload);
      },
    },
    ui: {
      label: "Trigger",
    },
  };
}

export function createUnknownTriggerDefinition(
  triggerType: string
): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: triggerType,
      executionType: "manual",
      evaluate(input) {
        return evaluateDefaultRouting(input.payload);
      },
    },
    ui: {
      label: triggerType,
    },
  };
}
