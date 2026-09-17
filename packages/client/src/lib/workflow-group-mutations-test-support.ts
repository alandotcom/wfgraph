/**
 * The graph store the Group mutation tests drive. `createGraphStore` loads a
 * graph into a fresh store whose saves go to `updateMock` with no debounce, and
 * the fixtures build the steps and Groups those graphs hold. Each test file
 * clears `updateMock` before every case.
 */

import { expect, vi } from "vitest";
import { createStore } from "jotai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { undersizedGroupIds } from "@wfgraph/shared/graph/node-group";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  recordLoadedDraftRevisionAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import type { WorkflowData } from "#src/lib/rpc-client";
import { savedWorkflow } from "./workflow-save-test-support";

export type Store = ReturnType<typeof createStore>;
export type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/** The store's `workflow.update`, which answers every save with success. */
export const updateMock = vi.fn(
  (
    _workflowId: string,
    _workflow: Partial<WorkflowData>,
    _expectedDraftRevision?: number
  ) => Promise.resolve(savedWorkflow("workflow_1"))
);

/** The graph one `workflow.update` call carried. */
function savedGraph(workflow: Partial<WorkflowData>): Graph {
  return { nodes: workflow.nodes ?? [], edges: workflow.edges ?? [] };
}

export function lifecycle(): WorkflowNode {
  return {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Start", type: "lifecycle", config: {} },
  };
}

export function lookup(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y: 200 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
  };
}

export function condition(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 400 },
    data: {
      label: id,
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
    },
  };
}

export function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return omitUndefined({ id, source, target, sourceHandle });
}

/** Two lookups join at a Condition whose True branch reaches `after`. */
export function ungroupedGraph(): Graph {
  return {
    nodes: [
      lifecycle(),
      lookup("a", 0),
      lookup("b", 200),
      condition("c"),
      { ...lookup("after", 100), position: { x: 100, y: 600 } },
    ],
    edges: [
      edge("start-a", "life", "a", "started"),
      edge("start-b", "life", "b", "started"),
      edge("a-c", "a", "c"),
      edge("b-c", "b", "c"),
      edge("c-after", "c", "after", "true"),
    ],
  };
}

export function createGraphStore(graph: Graph): Store {
  const store = createStore();
  store.set(workflowApiAtom, { update: updateMock });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(recordLoadedDraftRevisionAtom, {
    workflowId: "workflow_1",
    draftRevision: 1,
  });
  store.set(loadWorkflowGraphAtom, graph);
  return store;
}

/** Let a zero-delay debounce timer and a queued save drain. */
export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

export function graphOf(store: Store): Graph {
  return { nodes: store.get(nodesAtom), edges: store.get(edgesAtom) };
}

/**
 * What a save checks, and what the server's draft decoding checks, plus the
 * rule that every writer on the canvas dissolves a Group left too small.
 */
export function expectWholeGroups(graph: Graph) {
  expect(
    groupStructureRefusalReason({
      nodes: toPersistedNodes(graph.nodes),
      edges: graph.edges.map(toPersistedEdge),
    })
  ).toBeNull();
  expect(undersizedGroupIds(graph.nodes)).toEqual([]);
}

/** Every graph the store sent to `workflow.update`, each held to the Group rules. */
export function expectEverySaveWhole() {
  expect(updateMock).toHaveBeenCalled();
  for (const [, payload] of updateMock.mock.calls) {
    expectWholeGroups(savedGraph(payload));
  }
}

export function membersOf(store: Store, frameId: string): string[] {
  return store
    .get(nodesAtom)
    .filter((node) => node.parentId === frameId)
    .map((node) => node.id);
}

export function edgeIds(store: Store): string[] {
  return store.get(edgesAtom).map((item) => item.id);
}

/** The last graph the store sent to `workflow.update`. */
export function lastSaved(): Graph {
  const payload = updateMock.mock.calls.at(-1)?.[1];
  if (!payload) {
    throw new Error("expected a save");
  }
  return savedGraph(payload);
}
