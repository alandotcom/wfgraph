import type { JsonObject } from "@/types/json";
import { getValueByPath } from "@/utils/object-path";
import type {
  TriggerClassification,
  WorkflowTriggerDefinition,
} from "@/workflow/trigger-registry";
import { asNonEmptyString } from "@/workflow/webhook-routing";

function classifyDefaultPayload(payload: JsonObject): TriggerClassification {
  return {
    ok: true,
    eventType: asNonEmptyString(getValueByPath(payload, "event")),
    correlationKey: asNonEmptyString(getValueByPath(payload, "data.id")),
  };
}

export function createDefaultTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Trigger",
      executionType: "manual",
      evaluate(input) {
        return classifyDefaultPayload(input.payload);
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
        return classifyDefaultPayload(input.payload);
      },
    },
    ui: {
      label: triggerType,
    },
  };
}
