import { describe, expect, it } from "vitest";
import { validateWorkflowConditionConfigs } from "#src/backend/services/workflows/validation/workflow-conditions-validation";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "@rova/shared/conditions/conditions";
import type { WorkflowNode } from "@rova/shared/graph/types";

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
          "((has(payload.appointment) && has(payload.appointment.startsAt) && (payload.appointment.startsAt > now && payload.appointment.startsAt < now + days(1))))",
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

function createWaitNode(subscriptions: unknown): WorkflowNode {
  return {
    id: "wait-node",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitTimeout: "7d",
        waitFor: subscriptions,
      },
    },
  };
}

/**
 * The Wait node's match gets the Condition node's mid-edit carve-out, because
 * "Add a match" seeds a rule whose value is empty and the builder then makes
 * other edits. Refusing the save would refuse the editor's own default on every
 * autosave until they typed one.
 */
describe("validateWorkflowConditionConfigs over a Wait node's matches", () => {
  const seededMatch = serializeConditionModel(
    createDefaultConditionModel({
      path: "appointment.id",
      label: "appointment.id",
      type: "string",
    })
  );

  it("accepts a match whose operand the builder has not typed yet", () => {
    const result = validateWorkflowConditionConfigs([
      createWaitNode([
        { event: "app/appointment.updated", match: seededMatch },
      ]),
    ]);

    expect(result.valid).toBe(true);
  });

  it("accepts a match with no model at all", () => {
    const result = validateWorkflowConditionConfigs([
      createWaitNode([{ event: "app/appointment.updated" }]),
    ]);

    expect(result.valid).toBe(true);
  });

  it("refuses a match that is broken rather than unfinished", () => {
    const result = validateWorkflowConditionConfigs([
      createWaitNode([
        { event: "app/appointment.updated", match: "{not json" },
      ]),
    ]);

    expect(result.valid).toBe(false);
  });
});
