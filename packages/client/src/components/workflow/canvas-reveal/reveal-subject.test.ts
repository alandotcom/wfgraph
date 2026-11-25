import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  CONDITION_RULES_TARGET_ID,
  effectiveRevealLevel,
  isOrdinaryStep,
  matchConditionSubject,
  matchEventSplitSubject,
  matchGroupSubject,
  matchLifecycleSubject,
  matchPanelSubject,
  matchRunsSubject,
  matchStepSubject,
  revealFocusTarget,
  type RevealMatchInput,
  type RunsMatchInput,
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

/** The Runs kind's input: the shared input with no execution chosen. */
const runsInput = (
  workspace: RevealMatchInput["workspace"],
  nodeIds: string[]
): RunsMatchInput => ({ ...input(workspace, nodeIds), chosenExecution: null });

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
  it("matches a Draft ordinary step at one level, with a phone editor once its action is chosen", () => {
    expect(matchStepSubject(input("draft", ["send"]))).toMatchObject({
      kind: "step",
      nodeId: "send",
      levels: ["browse"],
      offersInspectorSheet: true,
    });
    expect(matchStepSubject(input("draft", ["blank"]))).toMatchObject({
      kind: "step",
      levels: ["browse"],
      offersInspectorSheet: false,
    });
  });

  it("refuses other objects, several objects, and other workspaces", () => {
    expect(matchStepSubject(input("draft", ["condition"]))).toBeNull();
    expect(matchStepSubject(input("draft", ["send", "wait"]))).toBeNull();
    expect(matchStepSubject(input("runs", ["send"]))).toBeNull();
  });
});

describe("matchConditionSubject", () => {
  it("matches a Draft Condition alone at one level, with its outlets placed", () => {
    expect(matchConditionSubject(input("draft", ["condition"]))).toEqual({
      kind: "condition",
      workspace: "draft",
      key: "node:condition",
      nodeId: "condition",
      placement: { kind: "node-outlets", nodeId: "condition" },
      levels: ["browse"],
      offersInspectorSheet: true,
      runsTarget: null,
    });
  });

  it("refuses other steps, several objects, and other workspaces", () => {
    expect(matchConditionSubject(input("draft", ["send"]))).toBeNull();
    expect(matchConditionSubject(input("draft", ["split"]))).toBeNull();
    expect(
      matchConditionSubject(input("draft", ["condition", "send"]))
    ).toBeNull();
    expect(matchConditionSubject(input("runs", ["condition"]))).toBeNull();
  });
});

describe("matchGroupSubject", () => {
  it("matches a Draft Group frame selected alone at one level", () => {
    expect(matchGroupSubject(input("draft", ["group"]))).toEqual({
      kind: "group",
      workspace: "draft",
      key: "node:group",
      nodeId: "group",
      placement: { kind: "nodes", nodeIds: ["group"] },
      levels: ["browse"],
      offersInspectorSheet: true,
      runsTarget: null,
    });
  });

  it("refuses a step, several objects, and Runs", () => {
    expect(matchGroupSubject(input("draft", ["send"]))).toBeNull();
    expect(matchGroupSubject(input("draft", ["group", "send"]))).toBeNull();
    expect(matchGroupSubject(input("runs", ["group"]))).toBeNull();
  });
});

describe("matchLifecycleSubject", () => {
  it("matches the Draft Lifecycle Node alone at one level", () => {
    expect(matchLifecycleSubject(input("draft", ["lifecycle"]))).toEqual({
      kind: "lifecycle",
      workspace: "draft",
      key: "node:lifecycle",
      nodeId: "lifecycle",
      placement: { kind: "nodes", nodeIds: ["lifecycle"] },
      levels: ["browse"],
      offersInspectorSheet: true,
      runsTarget: null,
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

describe("matchEventSplitSubject", () => {
  it("matches a Draft Event Split alone, with no editor and its outlets placed", () => {
    expect(matchEventSplitSubject(input("draft", ["split"]))).toEqual({
      kind: "eventSplit",
      workspace: "draft",
      key: "node:split",
      nodeId: "split",
      placement: { kind: "node-outlets", nodeId: "split" },
      levels: ["browse"],
      offersInspectorSheet: false,
      runsTarget: null,
    });
  });

  it("refuses other steps, several objects, and other workspaces", () => {
    expect(matchEventSplitSubject(input("draft", ["send"]))).toBeNull();
    expect(matchEventSplitSubject(input("draft", ["condition"]))).toBeNull();
    expect(
      matchEventSplitSubject(input("draft", ["split", "send"]))
    ).toBeNull();
    expect(matchEventSplitSubject(input("runs", ["split"]))).toBeNull();
  });
});

describe("matchPanelSubject", () => {
  it("shows every other Draft selection the graph holds, at Browse only", () => {
    expect(matchPanelSubject(input("draft", ["send", "wait"]))).toMatchObject({
      kind: "panel",
      nodeId: null,
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

  it("leaves Runs to its own kind", () => {
    expect(matchPanelSubject(input("runs", ["send"]))).toBeNull();
  });
});

describe("matchRunsSubject", () => {
  it("always shows Runs, placing the selected node or the whole graph", () => {
    expect(matchRunsSubject(runsInput("runs", []))).toMatchObject({
      kind: "runs",
      key: "graph",
      nodeId: null,
      placement: { kind: "graph" },
      levels: ["browse"],
      runsTarget: null,
    });
    expect(matchRunsSubject(runsInput("runs", ["send"]))).toMatchObject({
      kind: "runs",
      key: "node:send",
      nodeId: "send",
      placement: { kind: "nodes", nodeIds: ["send"] },
      runsTarget: { kind: "node", nodeId: "send" },
    });
  });

  it("offers Focus for a selected node's evidence and never for a Group frame", () => {
    expect(matchRunsSubject(runsInput("runs", ["send"]))?.levels).toEqual([
      "browse",
      "focus",
    ]);
    expect(matchRunsSubject(runsInput("runs", ["group"]))).toMatchObject({
      key: "node:group",
      nodeId: "group",
      levels: ["browse"],
      runsTarget: { kind: "group", groupId: "group" },
    });
    expect(
      matchRunsSubject(runsInput("runs", ["send", "wait"]))?.levels
    ).toEqual(["browse"]);
  });

  it("offers Focus for a chosen execution of a node nothing selects", () => {
    expect(
      matchRunsSubject({
        ...runsInput("runs", []),
        chosenExecution: { nodeId: "removed", logId: "log_1" },
      })
    ).toMatchObject({
      key: "execution-node:removed",
      nodeId: "removed",
      placement: { kind: "graph" },
      levels: ["browse", "focus"],
    });
  });

  it("refuses Draft", () => {
    expect(matchRunsSubject(runsInput("draft", ["send"]))).toBeNull();
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
  it("shows Browse without a subject and limits the level to the subject's levels", () => {
    const runNode = matchRunsSubject(runsInput("runs", ["send"]));
    const step = matchStepSubject(input("draft", ["send"]));
    expect(effectiveRevealLevel("focus", null)).toBe("browse");
    expect(effectiveRevealLevel("focus", runNode)).toBe("focus");
    // A Focus level remembered for a Draft step shows its one level.
    expect(effectiveRevealLevel("focus", step)).toBe("browse");
  });
});
