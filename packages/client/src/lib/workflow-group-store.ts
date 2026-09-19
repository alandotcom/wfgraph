/**
 * Group-aware graph mutations: grouping, connections, and complete deletions.
 * Every deletion resolves its targets before writing graph cells, records one
 * undo step, repairs selection, and requests one save of the resulting graph.
 */

import { atom, type Getter, type Setter } from "jotai";
import {
  groupSelection,
  removeGroupWithMembers,
  removeNodes,
  storedEdgeIdsForPaintedEdge,
  ungroupNode,
} from "#src/lib/node-group";
import { generateId } from "@wfgraph/shared/utils/id";
import type { WorkflowNode, WorkflowEdge } from "#src/lib/workflow-graph-types";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  planConnection,
  type ConnectionPlan,
  type RequestedConnection,
} from "#src/components/workflow/connection-validation";
import {
  draftEditable,
  edgesStateAtom,
  nodesStateAtom,
  pushHistory,
  requestGraphSave,
} from "#src/lib/workflow-graph-cells";
import {
  EMPTY_SELECTION,
  selectionInGraph,
} from "#src/lib/workflow-navigation-state";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";

/**
 * Wrap a selection `analyzeGroupableSelection` accepts in a Group frame, as one
 * undo step. `selectedIds` is for a caller whose live selection has already
 * collapsed; omitting it groups the selected nodes of the active address. The
 * new frame becomes the selection.
 */
export const groupSelectionAtom = atom(
  null,
  (get, set, input?: { selectedIds?: ReadonlySet<string> | undefined }) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const ids = input?.selectedIds ?? new Set(get(activeSelectionAtom).nodeIds);
    const grouped = groupSelection({
      nodes,
      edges: get(edgesStateAtom),
      selectedIds: ids,
    });
    if (!grouped) {
      return false;
    }

    pushHistory(get, set);
    set(nodesStateAtom, grouped.nodes);
    set(edgesStateAtom, grouped.edges);
    set(activeSelectionAtom, {
      nodeIds: [grouped.groupId],
      edgeIds: [],
    });
    requestGraphSave(get, set, { immediate: true });
    return true;
  }
);

/** Lift children out of a Group and remove the frame. */
export const ungroupNodeAtom = atom(null, (get, set, nodeId: string) => {
  if (!draftEditable(get)) {
    return false;
  }

  const nodes = get(nodesStateAtom);
  const target = nodes.find((node) => node.id === nodeId);
  const groupId = isGroupNode(target) ? nodeId : target?.parentId;
  if (!groupId) {
    return false;
  }

  const next = ungroupNode({ nodes, groupId });
  if (next === nodes) {
    return false;
  }

  pushHistory(get, set);
  set(nodesStateAtom, next);
  set(activeSelectionAtom, EMPTY_SELECTION);
  requestGraphSave(get, set, { immediate: true });
  return true;
});

/**
 * Delete a Group frame together with its members and every stored edge that
 * touches a member, as one undo step. Removing a frame on its own ungroups it,
 * so this is the one operation that deletes a Group's steps, and every caller
 * asks the person to confirm first.
 */
export const deleteGroupWithMembersAtom = atom(
  null,
  (get, set, groupId: string) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const next = removeGroupWithMembers({
      nodes,
      edges: get(edgesStateAtom),
      groupId,
    });
    return commitDeletion(get, set, next, "clear");
  }
);

/** Commit one complete deletion; callers resolve targets before changing cells. */
function commitDeletion(
  get: Getter,
  set: Setter,
  input: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  selection: "clear" | "retain"
): boolean {
  if (
    input.nodes === get(nodesStateAtom) &&
    input.edges.length === get(edgesStateAtom).length
  ) {
    return false;
  }
  pushHistory(get, set);
  set(nodesStateAtom, input.nodes);
  set(edgesStateAtom, input.edges);
  set(
    activeSelectionAtom,
    selection === "clear"
      ? EMPTY_SELECTION
      : selectionInGraph(get(activeSelectionAtom), input)
  );
  requestGraphSave(get, set, { immediate: true });
  return true;
}

/** Resolve painted edges against the intact graph, then remove all targets together. */
function deleteItems(
  get: Getter,
  set: Setter,
  input: {
    nodeIds: readonly string[];
    edgeIds: readonly string[];
    selection: "clear" | "retain";
  }
): void {
  if (!draftEditable(get)) {
    return;
  }
  const nodes = get(nodesStateAtom);
  const edges = get(edgesStateAtom);
  const scope = get(activeWorkspaceAddressAtom).scope;
  const removedEdges = new Set(
    input.edgeIds.flatMap((edgeId) =>
      storedEdgeIdsForPaintedEdge({ nodes, edges, edgeId, scope })
    )
  );
  const next =
    input.nodeIds.length === 0
      ? { nodes, edges }
      : removeNodes({ nodes, edges, nodeIds: new Set(input.nodeIds) });
  commitDeletion(
    get,
    set,
    {
      nodes: next.nodes,
      edges:
        removedEdges.size === 0
          ? next.edges
          : next.edges.filter((edge) => !removedEdges.has(edge.id)),
    },
    input.selection
  );
}

export const deleteNodeAtom = atom(null, (get, set, nodeId: string) => {
  deleteItems(get, set, {
    nodeIds: [nodeId],
    edgeIds: [],
    selection: "retain",
  });
});

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
  deleteItems(get, set, { ...get(activeSelectionAtom), selection: "clear" });
});

/**
 * Delete the canvas selection, not React Flow's implied descendants or edges.
 * A selected frame is ungrouped; ordinary deletion retains surviving selection.
 */
export const deleteCanvasSelectionAtom = atom(null, (get, set) => {
  const selection = get(activeSelectionAtom);
  const selectedIds = new Set(selection.nodeIds);
  const includesFrame = get(nodesStateAtom).some(
    (node) => selectedIds.has(node.id) && isGroupNode(node)
  );
  deleteItems(get, set, {
    ...selection,
    selection: includesFrame ? "clear" : "retain",
  });
});

/**
 * Connect two nodes, recorded as an undo step like every graph mutation.
 * `planConnection` decides against the stored graph what the connection adds:
 * a connection onto a Group card fans out onto the Group's entries. Answers the
 * plan, so a caller can show a refusal, or null when the draft is not editable.
 * A refused connection stores nothing. The first added edge takes
 * `connection.id`, which names a new edge, so the plan replaces no stored edge.
 */
export const connectNodesAtom = atom(
  null,
  (
    get,
    set,
    input: {
      connection: RequestedConnection & { id: string };
      throughBoundaryStub?: boolean | undefined;
      catalog: ExtensionCatalog;
    }
  ): ConnectionPlan | null => {
    if (!draftEditable(get)) {
      return null;
    }

    const { id, ...requested } = input.connection;
    const currentEdges = get(edgesStateAtom);
    const plan = planConnection({
      connection: requested,
      throughBoundaryStub: input.throughBoundaryStub,
      nodes: get(nodesStateAtom),
      storeEdges: currentEdges,
      catalog: input.catalog,
    });
    if ("refusal" in plan) {
      return plan;
    }

    pushHistory(get, set);
    set(edgesStateAtom, [
      ...currentEdges,
      ...plan.additions.map((addition, index) => ({
        id: index === 0 ? id : generateId(),
        ...addition,
      })),
    ]);
    requestGraphSave(get, set, { immediate: true });
    return plan;
  }
);

export const deleteEdgeAtom = atom(null, (get, set, edgeId: string) => {
  deleteItems(get, set, {
    nodeIds: [],
    edgeIds: [edgeId],
    selection: "retain",
  });
});
