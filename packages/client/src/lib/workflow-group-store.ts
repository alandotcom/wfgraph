/**
 * Group mutations on the canvas graph: wrap a selection, lift it back out,
 * delete a Group with its steps, connect through a frame (fan-out onto its
 * derived entries), and delete a painted inlet.
 *
 * Graph cells stay in workflow-graph-cells; this file is the operations.
 */

import { atom } from "jotai";
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
  groupOutletHandle,
} from "@wfgraph/shared/graph/node-group";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";
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
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";

/**
 * Wrap a valid lookup+Condition selection in a Group frame.
 *
 * The catalog is an argument rather than a read, because this runs outside
 * React and the analysis needs each member's `sideEffect`. `selectedIds` is
 * for a caller whose live selection has already collapsed; omitting it groups
 * the selected nodes of the active address. The new frame becomes the
 * selection.
 */
export const groupSelectionAtom = atom(
  null,
  (
    get,
    set,
    input: { catalog: ExtensionCatalog; selectedIds?: ReadonlySet<string> }
  ) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const ids = input.selectedIds ?? new Set(get(activeSelectionAtom).nodeIds);
    const grouped = groupSelection({
      nodes,
      edges: get(edgesStateAtom),
      selectedIds: ids,
      catalog: input.catalog,
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

  const next = ungroupNode(nodes, groupId);
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
