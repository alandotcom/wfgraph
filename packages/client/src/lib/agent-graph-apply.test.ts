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
  undoAtom,
} from "#src/lib/workflow-graph-store";
import { savedWorkflow } from "./workflow-save-test-support";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  activeAgentTurnIdAtom,
  agentGraphRevisionAtom,
  isGeneratingAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

const catalog = emptyExtensionCatalog;
const turnId = Symbol("agent-turn");

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
    update: vi.fn(() => Promise.resolve(savedWorkflow("workflow_1"))) as never,
  });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(activeAgentTurnIdAtom, turnId);
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  return store;
}

describe("applyAgentGraphAtom", () => {
  it("puts the agent's graph on the canvas", () => {
    const store = createGraphStore([actionNode("a")]);

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
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
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });
    const settled = store.get(nodesAtom);

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: false,
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
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
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
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("refuses while a past run is pinned to the canvas", () => {
    const store = createGraphStore([actionNode("a")]);
    // The overlay only owns the canvas while the owner has Runs open,
    // so both have to be true for the refusal to be the one under test.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [actionNode("a")],
      edges: [],
    });

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a"]);
  });

  it("refuses a graph from a workflow that is no longer open", () => {
    const store = createGraphStore([actionNode("current")]);

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_that_was_left",
      turnId,
      recordHistory: true,
      nodes: [actionNode("stale")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["current"]);
    expect(store.get(canUndoAtom)).toBe(false);
  });

  it("records one undo boundary across all graph updates in a turn", () => {
    const store = createGraphStore([actionNode("a")]);

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("a"), actionNode("b")],
      edges: [],
      catalog,
    });
    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: false,
      nodes: [actionNode("a"), actionNode("b"), actionNode("c")],
      edges: [],
      catalog,
    });

    store.set(undoAtom);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["a"]);
    expect(store.get(canUndoAtom)).toBe(false);
  });

  it("reflows existing nodes while placing a new node", () => {
    const positioned = {
      ...actionNode("a"),
      position: { x: 725, y: 315 },
    };
    const store = createGraphStore([positioned]);

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("a"), actionNode("b")],
      edges: [{ id: "e1", source: "a", target: "b" }],
      catalog,
    });

    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.position
    ).not.toEqual(positioned.position);
    expect(store.get(agentGraphRevisionAtom)).toBe(1);
  });

  it("refuses a graph from a turn that has already been replaced", () => {
    const store = createGraphStore([actionNode("current")]);
    store.set(activeAgentTurnIdAtom, Symbol("newer-turn"));

    store.set(applyAgentGraphAtom, {
      workflowId: "workflow_1",
      turnId,
      recordHistory: true,
      nodes: [actionNode("stale")],
      edges: [],
      catalog,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["current"]);
  });
});
