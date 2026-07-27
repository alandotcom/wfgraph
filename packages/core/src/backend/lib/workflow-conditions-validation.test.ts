import { describe, expect, it } from "bun:test";
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
          "((appointment.startsAt > now && appointment.startsAt < now + days(1)))",
      }),
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
