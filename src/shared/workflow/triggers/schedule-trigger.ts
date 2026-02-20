import { getValueByPath } from "@/shared/utils/object-path";
import type { WorkflowTriggerDefinition } from "@/shared/workflow/trigger-registry";
import { asNonEmptyString } from "@/shared/workflow/webhook-routing";

export function createScheduleTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Schedule",
      executionType: "manual",
      evaluate(input) {
        const eventType = asNonEmptyString(
          getValueByPath(input.payload, "event")
        );
        const correlationKey = asNonEmptyString(
          getValueByPath(input.payload, "data.id")
        );

        return {
          eventType,
          correlationKey,
          routingDecision: { kind: "start" },
        };
      },
    },
    ui: {
      label: "Schedule",
    },
  };
}
