import type { JsonObject } from "#src/types/json";
import { getValueByPath } from "#src/utils/object-path";
import type {
  TriggerClassification,
  WorkflowTriggerDefinition,
} from "#src/workflow/trigger-registry";
import { asNonEmptyString } from "#src/workflow/webhook-routing";

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
