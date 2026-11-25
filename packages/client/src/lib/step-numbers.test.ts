import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

function node(id: string, type: "lifecycle" | "action"): WorkflowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, type },
  };
}

const DRAFT = {
  nodes: [node("start", "lifecycle"), node("a", "action"), node("b", "action")],
  edges: [
    { id: "s-a", source: "start", target: "a", sourceHandle: "started" },
    { id: "a-b", source: "a", target: "b", sourceHandle: null },
  ] satisfies WorkflowEdge[],
};

function storeOnRoute(search: Parameters<typeof showWorkspaceRoute>[1]) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, DRAFT);
  showWorkspaceRoute(store, search);
  return store;
}

describe("stepNumbersAtom", () => {
  it("numbers the draft the canvas draws in Runs while no run is open", () => {
    const store = storeOnRoute({ view: "runs" });

    expect([...store.get(stepNumbersAtom)]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("numbers the open run's pinned graph in Runs", () => {
    const store = storeOnRoute({ view: "runs", executionId: "exec_1" });
    store.set(executionOverlayGraphAtom, {
      nodes: [node("start", "lifecycle"), node("b", "action")],
      edges: [
        { id: "s-b", source: "start", target: "b", sourceHandle: "started" },
      ],
    });

    expect([...store.get(stepNumbersAtom)]).toEqual([["b", 1]]);
  });
});
