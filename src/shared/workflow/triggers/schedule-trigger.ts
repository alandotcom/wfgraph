import { getValueByPath } from "@/shared/utils/object-path";
import type { WorkflowTriggerDefinition } from "@/shared/workflow/trigger-registry";
import { asNonEmptyString } from "@/shared/workflow/webhook-routing";

export function createScheduleTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    type: "Schedule",
    label: "Schedule",
    executionType: "manual",
    evaluate(input) {
      const eventType = asNonEmptyString(
        getValueByPath(input.payload, "event")
      );
      const correlationKey = asNonEmptyString(
        getValueByPath(input.payload, "data.id")
      );

      return {
        triggerType: "Schedule",
        executionType: "manual",
        eventType,
        correlationKey,
        routingDecision: { kind: "start" },
      };
    },
  };
}
