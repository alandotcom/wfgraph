/**
 * Group mutations on the canvas graph: wrap a selection, lift it back out,
 * delete a Group with its steps, connect through a frame (fan-out onto its
 * derived entries), and delete a painted inlet.
 *
 * Graph cells stay in workflow-graph-cells; this file is the operations.
 */

import { atom, type Getter, type Setter } from "jotai";
import {
  groupSelection,
  removeGroupWithMembers,
  ungroupNode,
} from "#src/lib/node-group";
import { generateId } from "@wfgraph/shared/utils/id";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  fanOutStoreEdges,
  fanOutStoreEdgeIds,
  groupLayoutDirection,
  groupOutletHandle,
} from "@wfgraph/shared/graph/node-group";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import type { GroupLayoutDirection } from "@wfgraph/shared/graph/schemas";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
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
  forgetGroupCamerasAtom,
} from "#src/lib/workflow-workspace-navigation";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

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

/**
 * Store `direction` as the Group frame's authored layout direction, as one undo
 * step that saves. The direction is organizational, so members, their data and
 * the stored edges stay as they are. The Group's saved focused cameras are
 * cleared, since they framed the other layout. Answers false when `groupId`
 * names no frame or the frame is already laid out along `direction`.
 */
export const setGroupDirectionAtom = atom(
  null,
  (get, set, input: { groupId: string; direction: GroupLayoutDirection }) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const frame = nodes.find((node) => node.id === input.groupId);
    if (
      frame === undefined ||
      !isGroupNode(frame) ||
      groupLayoutDirection(frame) === input.direction
    ) {
      return false;
    }

    pushHistory(get, set);
    set(
      nodesStateAtom,
      nodes.map((node) =>
        node === frame
          ? {
              ...node,
              data: {
                ...node.data,
                config: { ...node.data.config, direction: input.direction },
              },
            }
          : node
      )
    );
    forgetGroupCameras(get, set, [input.groupId]);
    requestGraphSave(get, set, { immediate: true });
    return true;
  }
);

function forgetGroupCameras(
  get: Getter,
  set: Setter,
  groupIds: readonly string[]
): void {
  const workflowId = get(currentWorkflowIdAtom);
  if (workflowId === null) {
    return;
  }
  for (const groupId of groupIds) {
    set(forgetGroupCamerasAtom, { workflowId, groupId });
  }
}

/**
 * Clear the saved focused cameras of every Group whose layout direction differs
 * between `before` and `after`, as when undo or redo replaced the graph.
 */
export function forgetFlippedGroupCameras(
  get: Getter,
  set: Setter,
  graphs: { before: readonly WorkflowNode[]; after: readonly WorkflowNode[] }
): void {
  const directionBefore = new Map(
    graphs.before
      .filter((node) => isGroupNode(node))
      .map((frame) => [frame.id, groupLayoutDirection(frame)])
  );
  const flipped = graphs.after
    .filter(
      (node) =>
        isGroupNode(node) &&
        directionBefore.has(node.id) &&
        directionBefore.get(node.id) !== groupLayoutDirection(node)
    )
    .map((frame) => frame.id);
  forgetGroupCameras(get, set, flipped);
}

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

  const next = ungroupNode({ nodes, edges: get(edgesStateAtom), groupId });
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
    if (next.nodes === nodes) {
      return false;
    }

    pushHistory(get, set);
    set(nodesStateAtom, next.nodes);
    set(edgesStateAtom, next.edges);
    set(activeSelectionAtom, EMPTY_SELECTION);
    requestGraphSave(get, set, { immediate: true });
    return true;
  }
);

/** Connect two nodes, recorded as an undo step like every graph mutation. */
export const connectNodesAtom = atom(null, (get, set, edge: WorkflowEdge) => {
  if (!draftEditable(get)) {
    return;
  }

  const nodes = get(nodesStateAtom);
  const currentEdges = get(edgesStateAtom);
  const sourceHandle =
    groupOutletHandle(nodes, currentEdges, edge.source) ?? edge.sourceHandle;
  const additions = fanOutStoreEdges({
    nodes,
    edges: currentEdges,
    sourceId: edge.source,
    targetId: edge.target,
    sourceHandle,
  }).map((item, index) =>
    // React Flow declares `sourceHandle` as optional, so a fan-out edge
    // leaving an unnamed handle omits it.
    omitUndefined({
      ...edge,
      id: index === 0 ? edge.id : generateId(),
      source: item.source,
      target: item.target,
      sourceHandle: item.sourceHandle,
    })
  );
  if (additions.length === 0) {
    return;
  }

  pushHistory(get, set);
  set(edgesStateAtom, [...currentEdges, ...additions]);
  requestGraphSave(get, set, { immediate: true });
});

export const deleteEdgeAtom = atom(null, (get, set, edgeId: string) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentEdges = get(edgesStateAtom);
  const removedIds = new Set(
    fanOutStoreEdgeIds(get(nodesStateAtom), currentEdges, edgeId)
  );
  if (removedIds.size === 0) {
    return;
  }
  const remaining = currentEdges.filter((edge) => !removedIds.has(edge.id));
  if (remaining.length === currentEdges.length) {
    return;
  }

  pushHistory(get, set);
  set(edgesStateAtom, remaining);

  set(
    activeSelectionAtom,
    selectionInGraph(get(activeSelectionAtom), {
      nodes: get(nodesStateAtom),
      edges: remaining,
    })
  );

  requestGraphSave(get, set, { immediate: true });
});
