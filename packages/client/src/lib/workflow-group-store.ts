/**
 * Group mutations on the canvas graph: wrap a selection, lift it back out,
 * connect through a frame (fan-out onto entries), and delete a painted inlet.
 *
 * Graph cells stay in workflow-graph-cells; this file is the operations.
 */

import { atom } from "jotai";
import { nanoid } from "nanoid";
import { groupSelection, ungroupNode } from "#src/lib/node-group";
import { canonicalizeNodeEnabled } from "@wfgraph/shared/graph/node-enabled";
import {
  childIdsOfGroup,
  fanOutStoreEdges,
  fanOutStoreEdgeIds,
  groupOutletHandle,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";
import {
  draftEditable,
  edgesStateAtom,
  nodesStateAtom,
  pushHistory,
  requestGraphSave,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";

/**
 * Wrap a valid lookup+Condition selection in a Group frame.
 *
 * The catalog is an argument rather than a read, because this runs outside
 * React and the analysis needs each member's `sideEffect`. `selectedIds` is
 * for a caller whose live selection has already collapsed; omitting it groups
 * whatever the canvas has selected.
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
    const ids =
      input.selectedIds ??
      new Set(nodes.filter((node) => node.selected).map((node) => node.id));
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
    const frame = grouped.nodes.find(
      (node) => isGroupNode(node) && node.selected
    );
    set(selectedNodeAtom, frame?.id ?? null);
    set(selectedEdgeAtom, null);
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
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);
  requestGraphSave(get, set, { immediate: true });
  return true;
});

/** Switch a whole frame off or on, which writes every member (`disabledGroupIds`). */
export const setGroupEnabledAtom = atom(
  null,
  (get, set, input: { groupId: string; enabled: boolean }) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const memberIds = new Set(childIdsOfGroup(nodes, input.groupId));
    if (memberIds.size === 0) {
      return false;
    }

    pushHistory(get, set);
    set(
      nodesStateAtom,
      nodes.map((node) =>
        memberIds.has(node.id)
          ? {
              ...node,
              data: canonicalizeNodeEnabled({
                ...node.data,
                enabled: input.enabled,
              }),
            }
          : node
      )
    );
    requestGraphSave(get, set);
    return true;
  }
);

/** Connect two nodes, recorded as an undo step like every graph mutation. */
export const connectNodesAtom = atom(null, (get, set, edge: WorkflowEdge) => {
  if (!draftEditable(get)) {
    return;
  }

  const nodes = get(nodesStateAtom);
  const sourceNode = nodes.find((node) => node.id === edge.source);
  const sourceHandle = groupOutletHandle(sourceNode) ?? edge.sourceHandle;
  const currentEdges = get(edgesStateAtom);
  const additions = fanOutStoreEdges({
    nodes,
    edges: currentEdges,
    sourceId: edge.source,
    targetId: edge.target,
    sourceHandle,
  }).map((item, index) => ({
    ...edge,
    id: index === 0 ? edge.id : nanoid(),
    source: item.source,
    target: item.target,
    sourceHandle: item.sourceHandle,
  }));
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

  if (get(selectedEdgeAtom) && removedIds.has(get(selectedEdgeAtom) ?? "")) {
    set(selectedEdgeAtom, null);
  }

  requestGraphSave(get, set, { immediate: true });
});
