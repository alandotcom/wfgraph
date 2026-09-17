import { describe, expect, it } from "vitest";
import type { ConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  conditionBranchTargets,
  conditionLogicSentence,
  readStoredConditionRules,
} from "./condition-reveal-summary";

const rule = (id: string) =>
  ({
    id,
    field: "data.status",
    fieldType: "string",
    operator: "equals",
    value: "active",
  }) as const;

const model = (
  groupLogic: "and" | "or",
  groups: Array<{ logic: "and" | "or"; count: number }>
): ConditionModel => ({
  version: 2,
  groupLogic,
  groups: groups.map((group, index) => ({
    id: `g${index}`,
    logic: group.logic,
    conditions: Array.from({ length: group.count }, (_, ruleIndex) =>
      rule(`r${index}-${ruleIndex}`)
    ),
  })),
});

describe("readStoredConditionRules", () => {
  it("tells an empty, unreadable, and stored model apart", () => {
    expect(readStoredConditionRules(undefined)).toEqual({ kind: "empty" });
    expect(readStoredConditionRules({ conditionModel: "  " })).toEqual({
      kind: "empty",
    });
    expect(readStoredConditionRules({ conditionModel: "{" })).toEqual({
      kind: "unreadable",
    });
    const stored = model("and", [{ logic: "and", count: 1 }]);
    expect(
      readStoredConditionRules({ conditionModel: JSON.stringify(stored) })
    ).toEqual({ kind: "model", model: stored });
  });
});

describe("conditionLogicSentence", () => {
  it("names the logic of one rule, one group, and several groups", () => {
    expect(
      conditionLogicSentence(model("and", [{ logic: "and", count: 1 }]))
    ).toBe("True when the rule matches, and False otherwise.");
    expect(
      conditionLogicSentence(model("and", [{ logic: "and", count: 3 }]))
    ).toBe("True when each of the 3 rules matches, and False otherwise.");
    expect(
      conditionLogicSentence(model("and", [{ logic: "or", count: 2 }]))
    ).toBe("True when any of the 2 rules matches, and False otherwise.");
    expect(
      conditionLogicSentence(
        model("and", [
          { logic: "or", count: 2 },
          { logic: "and", count: 1 },
        ])
      )
    ).toBe("True when each of the 2 groups matches, and False otherwise.");
    expect(
      conditionLogicSentence(
        model("or", [
          { logic: "and", count: 1 },
          { logic: "and", count: 1 },
          { logic: "and", count: 1 },
        ])
      )
    ).toBe("True when any of the 3 groups matches, and False otherwise.");
  });
});

describe("conditionBranchTargets", () => {
  const node = (id: string, label: string): WorkflowNode => ({
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: { actionType: "Wait" } },
  });
  const nodes = [
    node("condition", "Eligible?"),
    node("a", "Send"),
    node("b", "Skip"),
    node("c", "Log"),
  ];

  it("lists each outlet's steps and leaves a disconnected outlet empty", () => {
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "condition", target: "a", sourceHandle: "true" },
      { id: "e2", source: "condition", target: "c", sourceHandle: "true" },
      { id: "e3", source: "a", target: "b", sourceHandle: "false" },
      { id: "e4", source: "condition", target: "gone", sourceHandle: "false" },
    ];
    expect(
      conditionBranchTargets({
        nodeId: "condition",
        nodes,
        edges,
        catalog: { actions: [], events: [], entities: [], integrations: [] },
      })
    ).toEqual({
      true: [
        { edgeId: "e1", nodeId: "a", label: "Send" },
        { edgeId: "e2", nodeId: "c", label: "Log" },
      ],
      false: [],
    });
  });
});
