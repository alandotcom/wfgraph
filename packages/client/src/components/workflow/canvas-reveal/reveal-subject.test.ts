import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  effectiveRevealLevel,
  isOrdinaryStep,
  matchPanelSubject,
  matchStepSubject,
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

const nodes = [
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
  it("accepts Actions and Waits and refuses Conditions and Event Splits", () => {
    expect(nodes.map((node) => [node.id, isOrdinaryStep(node)])).toEqual([
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

describe("matchPanelSubject", () => {
  it("shows every other Draft selection the graph holds, at Browse only", () => {
    expect(matchPanelSubject(input("draft", ["condition"]))).toMatchObject({
      kind: "panel",
      nodeId: "condition",
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

  it("always shows Runs and Changes, placing the selected node or the whole graph", () => {
    for (const workspace of ["runs", "changes"] as const) {
      expect(matchPanelSubject(input(workspace, []))).toMatchObject({
        kind: "panel",
        key: "graph",
        placement: { kind: "graph" },
      });
      expect(matchPanelSubject(input(workspace, ["send"]))).toMatchObject({
        nodeId: "send",
        placement: { kind: "nodes", nodeIds: ["send"] },
      });
    }
  });
});

describe("effectiveRevealLevel", () => {
  it("closes without a subject and limits the level to the subject's levels", () => {
    const step = matchStepSubject(input("draft", ["send"]));
    const panel = matchPanelSubject(input("draft", ["condition"]));
    expect(effectiveRevealLevel("focus", null)).toBe("closed");
    expect(effectiveRevealLevel("focus", step)).toBe("focus");
    expect(effectiveRevealLevel("focus", panel)).toBe("browse");
    expect(effectiveRevealLevel("closed", step)).toBe("closed");
  });
});
