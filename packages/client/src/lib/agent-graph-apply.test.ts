import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  applyAgentGraphAtom,
  canUndoAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { savedWorkflow } from "./workflow-save-test-support";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  isGeneratingAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";

const catalog = emptyExtensionCatalog;

function actionNode(id: string, label = id): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: { actionType: "noop" } },
  };
}

function createGraphStore(nodes: WorkflowNode[]) {
  const store = createStore();
  store.set(workflowApiAtom, {
    create: vi.fn() as never,
    update: vi.fn(() => Promise.resolve(savedWorkflow("workflow_1"))) as never,
  });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  return store;
}

describe("applyAgentGraphAtom", () => {
  it("puts the agent's graph on the canvas", () => {
    const store = createGraphStore([actionNode("a")]);

    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b")],
      edges: [{ id: "e1", source: "a", target: "b" }],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a", "b"]);
    expect(store.get(edgesAtom).map((edge) => edge.id)).toEqual(["e1"]);
  });

  it("keeps the identity of a node the agent left alone", () => {
    const store = createGraphStore([actionNode("a"), actionNode("b")]);

    // The first apply settles the layout, because the agent chooses no
    // coordinates and every node it adds arrives at the origin. Identity is
    // about what happens from there: a turn calls several write tools, and each
    // one sends the whole graph back.
    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });
    const settled = store.get(nodesAtom);

    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b", "Renamed")],
      edges: [],
      catalog,
    });

    const after = store.get(nodesAtom);
    // The paint cache in `displayNodesAtom` is keyed on node identity, so a
    // rebuilt object for an unchanged step re-renders its card for nothing.
    expect(after.find((node) => node.id === "a")).toBe(
      settled.find((node) => node.id === "a")
    );
    expect(after.find((node) => node.id === "b")).not.toBe(
      settled.find((node) => node.id === "b")
    );
    expect(after.find((node) => node.id === "b")?.data.label).toBe("Renamed");
  });

  it("leaves one undo step for the turn", () => {
    const store = createGraphStore([actionNode("a")]);
    expect(store.get(canUndoAtom)).toBe(false);

    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });

    expect(store.get(canUndoAtom)).toBe(true);
  });

  it("still writes while the agent's own turn holds the canvas lock", () => {
    const store = createGraphStore([actionNode("a")]);
    // The turn sets this so the user cannot drag a node out from under an edit
    // in flight. The agent's own writes are the reason the lock exists, so they
    // are the one thing it must not stop.
    store.set(isGeneratingAtom, true);

    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("refuses while a past run is pinned to the canvas", () => {
    const store = createGraphStore([actionNode("a")]);
    // The overlay only owns the canvas while the owner has the Runs tab open,
    // so both have to be true for the refusal to be the one under test.
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [actionNode("a")],
      edges: [],
    });

    store.set(applyAgentGraphAtom, {
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a"]);
  });
});
