import { describe, expect, it } from "vitest";
import { validateWorkflowConditionConfigs } from "@/backend/lib/workflow-conditions-validation";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@rova/shared/workflow/conditions";
import type { WorkflowNode } from "@rova/shared/workflow/types";

function createConditionNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "condition-node",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Condition",
      type: "action",
      config: {
        actionType: "Condition",
        ...config,
      },
    },
  };
}

describe("validateWorkflowConditionConfigs", () => {
  it("accepts valid structured condition config", () => {
    const model = createDefaultConditionModel(
      {
        path: "appointment.startsAt",
        label: "appointment.startsAt",
        type: "timestamp",
      },
      {
        groupId: "group-1",
        conditionId: "condition-1",
      }
    );

    const result = validateWorkflowConditionConfigs([
      createConditionNode({
        conditionModel: serializeConditionModel(model),
        condition:
          "((payload.appointment.startsAt > now && payload.appointment.startsAt < now + days(1)))",
      }),
    ]);

    expect(result.valid).toBe(true);
  });

  it("accepts a node whose condition is still being built", () => {
    // The builder writes an empty expression until the rules compile. Saving the
    // graph has to keep working, or an unfinished condition would discard every
    // other edit in the same autosave; running is where the node is required to
    // be complete.
    const result = validateWorkflowConditionConfigs([
      createConditionNode({ condition: "", conditionModel: "" }),
    ]);

    expect(result.valid).toBe(true);
  });

  it("rejects legacy expression without model", () => {
    const result = validateWorkflowConditionConfigs([
      createConditionNode({
        condition: "status == 200",
      }),
    ]);

    expect(result.valid).toBe(false);
  });

  it("rejects mismatched compiled CEL", () => {
    const model = createDefaultConditionModel(
      {
        path: "appointment.startsAt",
        label: "appointment.startsAt",
        type: "timestamp",
      },
      {
        groupId: "group-1",
        conditionId: "condition-1",
      }
    );

    const result = validateWorkflowConditionConfigs([
      createConditionNode({
        conditionModel: serializeConditionModel(model),
        condition: "appointment.startsAt > now + days(10)",
      }),
    ]);

    expect(result.valid).toBe(false);
  });
});
