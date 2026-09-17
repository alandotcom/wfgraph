import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  CONDITION_RULES_TARGET_ID,
  effectiveRevealLevel,
  isOrdinaryStep,
  matchChangesSubject,
  matchConditionSubject,
  matchGroupSubject,
  matchLifecycleSubject,
  matchPanelSubject,
  matchRunsSubject,
  matchStepSubject,
  revealFocusTarget,
  type RevealMatchInput,
} from "./reveal-subject";

function action(id: string, actionType?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: actionType ? { actionType } : {},
    },
  };
}

const nodes: WorkflowNode[] = [
  {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Lifecycle", type: "lifecycle", config: {} },
  },
  {
    id: "group",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Group", type: "group" },
  },
  action("send", "resend/send-email"),
  action("wait", BUILT_IN_ACTION_IDS.wait),
  action("blank"),
  action("condition", BUILT_IN_ACTION_IDS.condition),
  action("split", BUILT_IN_ACTION_IDS.eventSplit),
];
const edges = [{ id: "e1", source: "send", target: "wait" }];

const input = (
  workspace: RevealMatchInput["workspace"],
  nodeIds: string[],
  edgeIds: string[] = []
): RevealMatchInput => ({
  workspace,
  selection: { nodeIds, edgeIds },
  nodes,
  edges,
});

describe("isOrdinaryStep", () => {
  it("accepts Actions and Waits and refuses the Lifecycle Node, Conditions, and Event Splits", () => {
    expect(nodes.map((node) => [node.id, isOrdinaryStep(node)])).toEqual([
      ["lifecycle", false],
      ["group", false],
      ["send", true],
      ["wait", true],
      ["blank", true],
      ["condition", false],
      ["split", false],
    ]);
  });
});

describe("matchStepSubject", () => {
  it("matches a Draft ordinary step, with Focus once its action is chosen", () => {
    expect(matchStepSubject(input("draft", ["send"]))).toMatchObject({
      kind: "step",
      nodeId: "send",
      levels: ["browse", "focus"],
    });
    expect(matchStepSubject(input("draft", ["blank"]))).toMatchObject({
      kind: "step",
      levels: ["browse"],
    });
  });

  it("refuses other objects, several objects, and other workspaces", () => {
    expect(matchStepSubject(input("draft", ["condition"]))).toBeNull();
    expect(matchStepSubject(input("draft", ["send", "wait"]))).toBeNull();
    expect(matchStepSubject(input("runs", ["send"]))).toBeNull();
  });
});

describe("matchConditionSubject", () => {
  it("matches a Draft Condition alone, with Focus and its outlets placed", () => {
    expect(matchConditionSubject(input("draft", ["condition"]))).toEqual({
      kind: "condition",
      workspace: "draft",
      key: "node:condition",
      nodeId: "condition",
      placement: { kind: "node-outlets", nodeId: "condition" },
      levels: ["browse", "focus"],
    });
  });

  it("refuses other steps, several objects, and other workspaces", () => {
    expect(matchConditionSubject(input("draft", ["send"]))).toBeNull();
    expect(matchConditionSubject(input("draft", ["split"]))).toBeNull();
    expect(
      matchConditionSubject(input("draft", ["condition", "send"]))
    ).toBeNull();
    expect(matchConditionSubject(input("runs", ["condition"]))).toBeNull();
    expect(matchConditionSubject(input("changes", ["condition"]))).toBeNull();
  });
});

describe("matchGroupSubject", () => {
  it("matches a Draft Group frame selected alone, with Focus", () => {
    expect(matchGroupSubject(input("draft", ["group"]))).toEqual({
      kind: "group",
      workspace: "draft",
      key: "node:group",
      nodeId: "group",
      placement: { kind: "nodes", nodeIds: ["group"] },
      levels: ["browse", "focus"],
    });
  });

  it("refuses a step, several objects, and Runs", () => {
    expect(matchGroupSubject(input("draft", ["send"]))).toBeNull();
    expect(matchGroupSubject(input("draft", ["group", "send"]))).toBeNull();
    expect(matchGroupSubject(input("runs", ["group"]))).toBeNull();
  });
});

describe("matchLifecycleSubject", () => {
  it("matches the Draft Lifecycle Node alone, with Focus", () => {
    expect(matchLifecycleSubject(input("draft", ["lifecycle"]))).toEqual({
      kind: "lifecycle",
      workspace: "draft",
      key: "node:lifecycle",
      nodeId: "lifecycle",
      placement: { kind: "nodes", nodeIds: ["lifecycle"] },
      levels: ["browse", "focus"],
    });
  });

  it("refuses a step, several objects, and other workspaces", () => {
    expect(matchLifecycleSubject(input("draft", ["send"]))).toBeNull();
    expect(
      matchLifecycleSubject(input("draft", ["lifecycle", "send"]))
    ).toBeNull();
    expect(matchLifecycleSubject(input("runs", ["lifecycle"]))).toBeNull();
  });
});

describe("matchPanelSubject", () => {
  it("shows every other Draft selection the graph holds, at Browse only", () => {
    expect(matchPanelSubject(input("draft", ["split"]))).toMatchObject({
      kind: "panel",
      nodeId: "split",
      levels: ["browse"],
    });
    expect(matchPanelSubject(input("draft", [], ["e1"]))).toMatchObject({
      kind: "panel",
      nodeId: null,
      placement: { kind: "nodes", nodeIds: ["send", "wait"] },
    });
    expect(matchPanelSubject(input("draft", []))).toBeNull();
    expect(matchPanelSubject(input("draft", ["deleted"]))).toBeNull();
  });

  it("leaves Runs and Changes to their own kinds", () => {
    expect(matchPanelSubject(input("runs", ["send"]))).toBeNull();
    expect(matchPanelSubject(input("changes", ["send"]))).toBeNull();
  });
});

describe("matchRunsSubject", () => {
  it("always shows Runs at Browse, placing the selected node or the whole graph", () => {
    expect(matchRunsSubject(input("runs", []))).toMatchObject({
      kind: "runs",
      key: "graph",
      nodeId: null,
      placement: { kind: "graph" },
      levels: ["browse"],
    });
    expect(matchRunsSubject(input("runs", ["send"]))).toMatchObject({
      kind: "runs",
      key: "node:send",
      nodeId: "send",
      placement: { kind: "nodes", nodeIds: ["send"] },
    });
  });

  it("refuses Draft and Changes", () => {
    expect(matchRunsSubject(input("draft", ["send"]))).toBeNull();
    expect(matchRunsSubject(input("changes", []))).toBeNull();
  });
});

describe("matchChangesSubject", () => {
  it("places the selected node, the selected connection's steps, or the whole graph, offering Focus for one object", () => {
    expect(matchChangesSubject(input("changes", []))).toMatchObject({
      kind: "changes",
      key: "graph",
      nodeId: null,
      placement: { kind: "graph" },
      levels: ["browse"],
    });
    expect(matchChangesSubject(input("changes", ["send"]))).toMatchObject({
      key: "node:send",
      nodeId: "send",
      placement: { kind: "nodes", nodeIds: ["send"] },
      levels: ["browse", "focus"],
    });
    expect(matchChangesSubject(input("changes", [], ["e1"]))).toMatchObject({
      key: "edge:e1",
      nodeId: null,
      placement: { kind: "nodes", nodeIds: ["send", "wait"] },
      levels: ["browse", "focus"],
    });
    expect(
      matchChangesSubject(input("changes", ["send", "wait"]))
    ).toMatchObject({ key: "graph", placement: { kind: "graph" } });
  });

  it("belongs to Changes alone", () => {
    expect(matchChangesSubject(input("draft", ["send"]))).toBeNull();
    expect(matchChangesSubject(input("runs", []))).toBeNull();
  });
});

describe("revealFocusTarget", () => {
  it("maps both Condition rule config keys to the rule builder", () => {
    expect(revealFocusTarget("condition", "condition")).toBe(
      CONDITION_RULES_TARGET_ID
    );
    expect(revealFocusTarget("condition", "conditionModel")).toBe(
      CONDITION_RULES_TARGET_ID
    );
  });

  it("leaves every other field and kind alone", () => {
    expect(revealFocusTarget("condition", "label")).toBe("label");
    expect(revealFocusTarget("step", "conditionModel")).toBe("conditionModel");
    expect(revealFocusTarget("panel", "to")).toBe("to");
  });
});

describe("effectiveRevealLevel", () => {
  it("closes without a subject and limits the level to the subject's levels", () => {
    const step = matchStepSubject(input("draft", ["send"]));
    const panel = matchPanelSubject(input("draft", ["split"]));
    expect(effectiveRevealLevel("focus", null)).toBe("closed");
    expect(effectiveRevealLevel("focus", step)).toBe("focus");
    expect(effectiveRevealLevel("focus", panel)).toBe("browse");
    expect(effectiveRevealLevel("closed", step)).toBe("closed");
  });
});
