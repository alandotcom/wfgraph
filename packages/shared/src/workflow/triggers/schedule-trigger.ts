import { getValueByPath } from "#src/utils/object-path";
import type { WorkflowTriggerDefinition } from "#src/workflow/trigger-registry";
import { asNonEmptyString } from "#src/workflow/webhook-routing";

export function createScheduleTriggerDefinition(): WorkflowTriggerDefinition {
  return {
    runtime: {
      type: "Schedule",
      executionType: "manual",
      evaluate(input) {
        return {
          ok: true,
          eventType: asNonEmptyString(getValueByPath(input.payload, "event")),
          correlationKey: asNonEmptyString(
            getValueByPath(input.payload, "data.id")
          ),
        };
      },
    },
    ui: {
      label: "Schedule",
    },
  };
}
