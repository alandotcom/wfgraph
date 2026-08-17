import type { EdgeChange, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import {
  cloneSelection,
  extractCopyableSelection,
  nodeIdsForContextCopy,
  offsetToOrigin,
  PASTE_OFFSET,
  type CopiedSelection,
} from "#src/lib/copy-selection";
import { repairNodeIntegrations } from "#src/lib/node-integration";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { SavedWorkflow } from "#src/lib/rpc-client";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
  saveWorkflowAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  activePropertiesTabAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { inactiveCanceledBranch } from "#src/lib/inactive-canceled-branch";
import { groupSelection, ungroupNode } from "#src/lib/node-group";
import {
  childIdsOfGroup,
  displayEdgesForGroups,
  isGroupNode,
  groupExitId,
  orderGroupParentsFirst,
  resolveStoredEndpoint,
  undersizedGroupIds,
} from "@wfgraph/shared/graph/node-group";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import type {
  NodeRunStatus,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
} from "#src/lib/workflow-graph-types";

/**
 * The graph the editor is showing, and every operation that may change it.
 *
 * The node and edge cells are private on purpose. A module writing to them
 * directly could change the graph without recording an undo step, the way
 * creating an edge or running auto-layout would. Exporting only read-only
 * views makes that mistake fail to compile, because jotai types the setter of
 * a read-only atom as `never`.
 *
 * Add an operation here rather than reaching for the cells.
 */
const nodesStateAtom = atom<WorkflowNode[]>([]);
const edgesStateAtom = atom<WorkflowEdge[]>([]);

const pinnedRunGraphAtom = atom<{
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} | null>(null);

/**
 * The published graph a selected run pinned, shown on the canvas instead of the
 * draft so node statuses land on the shape the run actually walked. Cleared
 * when the run is deselected. Never saved: draft atoms stay draft-only so a
 * Cmd+S or toolbar save cannot persist the run graph over the editor's draft.
 *
 * Reads as null while the Runs tab is down, on the same `activePropertiesTabAtom`
 * gate `selectedExecutionIdAtom` reads through, because the two describe one run
 * and must go off the canvas together. This gate covers the one exit that keeps
 * the run open on purpose: the tab bar's Properties button, which writes the tab
 * and not the URL, so coming back paints the same run again without a refetch.
 * An interaction that hides the whole surface instead clears the search through
 * `useLeaveRunsSurface`, and `ExecutionOverlaySync` nulls the write side.
 */
export const executionOverlayGraphAtom = atom(
  (get) =>
    get(activePropertiesTabAtom) === "runs" ? get(pinnedRunGraphAtom) : null,
  (
    _get,
    set,
    graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null
  ) => {
    set(pinnedRunGraphAtom, graph);
  }
);

/** Read-only draft. Mutate through the action atoms below so undo always sees it. */
export const nodesAtom = atom((get) => get(nodesStateAtom));
export const edgesAtom = atom((get) => get(edgesStateAtom));

/**
 * Run status by node id, independent of which graph is on screen.
 *
 * A status belongs to a run, not to a node, so it is never written into a
 * node's own `data` -- doing that is what used to force `executionOverlayGraphAtom`
 * to carry a full second copy of the graph just to hold a different status per
 * node. `displayNodesAtom` merges this onto the draft or the pinned overlay at
 * display time instead, the same way it already merges `inactiveCanceledBranchAtom`.
 */
const statusByNodeIdAtom = atom<ReadonlyMap<string, NodeRunStatus>>(new Map());

/** Whether the canvas is showing a run's pinned graph instead of the draft. */
export const isExecutionOverlayActiveAtom = atom(
  (get) => get(executionOverlayGraphAtom) !== null
);

/**
 * Whether the canvas is showing something other than an editable draft, so
 * anything that writes the draft has to refuse. Generation is rewriting the
 * graph underneath the user; a run overlay pins the canvas to a past run.
 *
 * Both the canvas (which drops React Flow's drag, connect and select props)
 * and the toolbar (which disables Publish) read this one atom, so the two
 * cannot drift apart: the whole point of #39 was that Publish had missed a
 * condition the canvas already had.
 */
export const canvasEditingLockedAtom = atom(
  (get) => get(isGeneratingAtom) || get(isExecutionOverlayActiveAtom)
);

/**
 * What the canvas paints: the run overlay when a run is open, otherwise the
 * draft. Saves, publish, and config always read `nodesAtom` / `edgesAtom`.
 *
 * When no Cancel Event is declared, the Canceled subtree is muted here via
 * React Flow presentation props (`style` / `data.displayLabel`) so the draft
 * stays clean.
 */
const inactiveCanceledBranchAtom = atom((get) => {
  const nodes = get(executionOverlayGraphAtom)?.nodes ?? get(nodesStateAtom);
  const edges = get(executionOverlayGraphAtom)?.edges ?? get(edgesStateAtom);
  return inactiveCanceledBranch({ nodes, edges });
});

const INACTIVE_NODE_STYLE = { opacity: 0.5 } as const;
const INACTIVE_EDGE_STYLE = { opacity: 0.4 } as const;

export const displayNodesAtom = atom((get) => {
  const nodes = get(executionOverlayGraphAtom)?.nodes ?? get(nodesStateAtom);
  const statusByNodeId = get(statusByNodeIdAtom);
  const { nodeIds } = get(inactiveCanceledBranchAtom);
  const ordered = orderGroupParentsFirst(nodes);

  // The common case -- no run is being painted and every Cancel Event outlet
  // is either connected or the graph has none -- has nothing to merge, so the
  // nodes come back exactly as they went in. React.memo on ActionNode and
  // LifecycleNode does a shallow prop comparison, and it can only bail out on
  // a node that is `===` what it rendered last time; a fresh `data` object on
  // every node, every recompute, defeats that on every drag frame and every
  // keystroke, since this atom is read on every render of the canvas.
  if (statusByNodeId.size === 0 && nodeIds.size === 0) {
    return ordered;
  }

  return ordered.map((node) => {
    const withStatus: WorkflowNode = {
      ...node,
      data: { ...node.data, status: statusByNodeId.get(node.id) ?? "idle" },
    };
    return nodeIds.has(node.id)
      ? {
          ...withStatus,
          style: { ...withStatus.style, ...INACTIVE_NODE_STYLE },
        }
      : withStatus;
  });
});
export const displayEdgesAtom = atom((get) => {
  const nodes = get(executionOverlayGraphAtom)?.nodes ?? get(nodesStateAtom);
  const edges = get(executionOverlayGraphAtom)?.edges ?? get(edgesStateAtom);
  const painted = displayEdgesForGroups(nodes, edges);
  const { edgeIds, outletEdgeIds } = get(inactiveCanceledBranchAtom);
  if (edgeIds.size === 0) {
    return painted;
  }
  return painted.map((edge) => {
    if (!edgeIds.has(edge.id)) {
      return edge;
    }
    return {
      ...edge,
      style: { ...edge.style, ...INACTIVE_EDGE_STYLE },
      ...(outletEdgeIds.has(edge.id)
        ? {
            data: {
              ...edge.data,
              displayLabel: "No Cancel Event",
            },
          }
        : {}),
    };
  });
});

/** Refuse draft mutations while a run overlay owns the canvas. */
function draftEditable(get: Getter): boolean {
  return get(executionOverlayGraphAtom) === null;
}

export const selectedNodeAtom = atom<string | null>(null);
export const selectedEdgeAtom = atom<string | null>(null);

// Tracks a just-created node so the config panel can focus its search input.
// Cleared once the node gets an action type or loses selection.
export const newlyCreatedNodeIdAtom = atom<string | null>(null);

type HistoryState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

const historyAtom = atom<HistoryState[]>([]);
const futureAtom = atom<HistoryState[]>([]);

type CopiedClipboard = {
  selection: CopiedSelection;
  pasteCount: number;
};

const copiedSelectionAtom = atom<CopiedClipboard | null>(null);

// Deep enough that no one reaches the end by hand, bounded so a long editing
// session cannot pin two copies of the graph per step in memory forever.
const HISTORY_LIMIT = 50;

// Whether a node drag is mid-flight, so the whole drag records one undo step
// rather than one per frame.
const isDraggingAtom = atom(false);

/** Snapshot the graph so the next change is undoable, and drop any redo branch. */
function pushHistory(get: Getter, set: Setter) {
  const snapshot: HistoryState = {
    nodes: get(nodesStateAtom),
    edges: get(edgesStateAtom),
  };
  const history = [...get(historyAtom), snapshot];

  set(historyAtom, history.slice(-HISTORY_LIMIT));
  set(futureAtom, []);
}

function dissolveUndersizedGroups(nodes: WorkflowNode[]): WorkflowNode[] {
  let next = nodes;
  for (const groupId of undersizedGroupIds(next)) {
    next = ungroupNode(next, groupId);
  }
  return next;
}

function idsRemovedWith(
  nodes: readonly WorkflowNode[],
  nodeId: string
): Set<string> {
  const ids = new Set([nodeId]);
  const target = nodes.find((node) => node.id === nodeId);
  if (isGroupNode(target)) {
    for (const childId of childIdsOfGroup(nodes, nodeId)) {
      ids.add(childId);
    }
  }
  return ids;
}
function requestGraphSave(
  get: Getter,
  set: Setter,
  options?: { immediate?: boolean }
) {
  void set(
    saveWorkflowAtom,
    { nodes: get(nodesStateAtom), edges: get(edgesStateAtom) },
    options
  );
}

/**
 * Replace the graph with what came back from the server.
 *
 * Clearing history is the point: undo history surviving a navigation between
 * workflows would let pressing undo after switching write the previous
 * workflow's graph into the current one, which autosave would then persist
 * under the wrong id.
 */
export const loadWorkflowGraphAtom = atom(
  null,
  (_get, set, graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => {
    set(nodesStateAtom, graph.nodes);
    set(edgesStateAtom, graph.edges);
    set(historyAtom, []);
    set(futureAtom, []);
    set(selectedNodeAtom, null);
    set(selectedEdgeAtom, null);
    set(newlyCreatedNodeIdAtom, null);
    set(hasUnsavedChangesAtom, false);
  }
);

/**
 * Put a workflow on screen: the graph, its identity, and who may edit it.
 *
 * Called from the route's loader, before the editor renders. A loader avoids
 * fetching from an effect in the editor and writing these one at a time, which
 * would need a ref comparing workflow ids to discard a response that arrived
 * after the user had already navigated elsewhere: the loader runs before the
 * component and the router cancels it on navigation.
 */
export const hydrateWorkflowAtom = atom(
  null,
  (_get, set, workflow: SavedWorkflow) => {
    // Clearing selection stops a node from arriving pre-selected in a
    // workflow the user has just opened.
    const nodes = workflow.nodes.map((node) => ({
      ...node,
      selected: false,
    }));

    // Also clears undo history, so undo cannot reach back past the switch and
    // write the previous workflow's graph into this one.
    set(loadWorkflowGraphAtom, { nodes, edges: workflow.edges });
    // Statuses belong to a run, not to the workflow, so a freshly loaded graph
    // shows none of the previous run's progress -- even if a node id happens
    // to be reused, which id generation makes exceedingly unlikely but the
    // status map cannot otherwise rule out.
    set(statusByNodeIdAtom, new Map());
    set(executionOverlayGraphAtom, null);
    set(selectedExecutionIdAtom, null);
    set(currentWorkflowIdAtom, workflow.id);
    set(currentWorkflowNameAtom, workflow.name);
    set(currentWorkflowVisibilityAtom, workflow.visibility ?? "private");
    set(currentWorkflowModeAtom, workflow.mode ?? "live");
    set(isWorkflowOwnerAtom, workflow.isOwner !== false);
    set(workflowNotFoundAtom, false);
    set(workflowLoadErrorAtom, null);
  }
);

/**
 * Point every node at a connection that exists, given the list as it stands now.
 *
 * Called from the handlers that already know the connection list changed, which
 * is the only moment a stored id can newly have gone stale while the editor is
 * open. `repairNodeIntegrations` returns the same array when nothing needed
 * fixing, so the common case writes nothing and queues no save.
 */
export const repairIntegrationsAtom = atom(
  null,
  (
    get,
    set,
    input: {
      integrations: readonly { id: string; type: string }[];
      catalog: ExtensionCatalog;
    }
  ) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);
    const repaired = repairNodeIntegrations(
      input.catalog,
      currentNodes,
      input.integrations
    );

    if (repaired === currentNodes) {
      return;
    }

    set(nodesStateAtom, repaired);
    requestGraphSave(get, set);
  }
);

/**
 * Record one undo step for a change the canvas is about to make itself.
 *
 * React Flow deletes in two passes, edges then nodes, so by the time either
 * change handler runs the graph is already half gone. The canvas calls this
 * from `onBeforeDelete`, which is the last moment the graph is still whole.
 */
export const snapshotHistoryAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }
  pushHistory(get, set);
});

/** Drop selection flags without touching the graph's shape. Not an undo step. */
export const clearGraphSelectionAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }
  set(
    nodesStateAtom,
    get(nodesStateAtom).map((node) => ({ ...node, selected: false }))
  );
  set(
    edgesStateAtom,
    get(edgesStateAtom).map((edge) => ({ ...edge, selected: false }))
  );
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);
});

/** Make one node the only selected node. Selection only, so not an undo step. */
export const selectOnlyNodeAtom = atom(null, (get, set, nodeId: string) => {
  if (!draftEditable(get)) {
    return;
  }
  set(
    nodesStateAtom,
    get(nodesStateAtom).map((node) => ({
      ...node,
      selected: node.id === nodeId,
    }))
  );
  set(selectedNodeAtom, nodeId);
  set(selectedEdgeAtom, null);
});

export const onNodesChangeAtom = atom(
  null,
  (get, set, changes: NodeChange<WorkflowNode>[]) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);

    // Lifecycle Nodes are the workflow's entrypoint; the graph is invalid
    // without one, so drop any attempt to remove them.
    const filteredChanges = changes.filter((change) => {
      if (change.type === "remove") {
        const nodeToRemove = currentNodes.find((n) => n.id === change.id);
        return nodeToRemove?.data.type !== "lifecycle";
      }
      return true;
    });

    const hasRemoval = filteredChanges.some(
      (change) => change.type === "remove"
    );
    const isDragFrame = filteredChanges.some(
      (change) => change.type === "position" && change.dragging === true
    );
    const isDragSettled = filteredChanges.some(
      (change) => change.type === "position" && change.dragging === false
    );

    // Removals are snapshotted by `snapshotHistoryAtom` before React Flow
    // starts emitting changes, because it splits one deletion into an edge
    // batch and a node batch. Snapshotting here would record two undo steps
    // for one delete, and a single undo would restore only half of it.
    if (isDragFrame && !get(isDraggingAtom)) {
      // A drag arrives as a stream of frames. Only the first still has the
      // pre-drag positions worth snapshotting.
      pushHistory(get, set);
      set(isDraggingAtom, true);
    }

    if (isDragSettled) {
      set(isDraggingAtom, false);
    }

    const newNodes = dissolveUndersizedGroups(
      applyNodeChanges<WorkflowNode>(filteredChanges, currentNodes)
    );
    set(nodesStateAtom, newNodes);

    // Mirror React Flow's own selection state onto our selection atoms.
    const selectedNode = newNodes.find((n) => n.selected);
    if (selectedNode) {
      set(selectedNodeAtom, selectedNode.id);
      set(selectedEdgeAtom, null);
      const newlyCreatedId = get(newlyCreatedNodeIdAtom);
      if (newlyCreatedId && newlyCreatedId !== selectedNode.id) {
        set(newlyCreatedNodeIdAtom, null);
      }
    } else if (get(selectedNodeAtom)) {
      const currentSelection = get(selectedNodeAtom);
      const stillExists = newNodes.find((n) => n.id === currentSelection);
      if (!stillExists) {
        set(selectedNodeAtom, null);
      }
      set(newlyCreatedNodeIdAtom, null);
    }

    if (hasRemoval) {
      requestGraphSave(get, set, { immediate: true });
    } else if (isDragSettled) {
      // Only a settled drag is worth saving; saving mid-drag would fire per frame.
      requestGraphSave(get, set);
    }
  }
);

export const onEdgesChangeAtom = atom(
  null,
  (get, set, changes: EdgeChange[]) => {
    if (!draftEditable(get)) {
      return;
    }

    // No history push here; see the note in onNodesChangeAtom.
    const hasRemoval = changes.some((change) => change.type === "remove");
    const newEdges = applyEdgeChanges(changes, get(edgesStateAtom));
    set(edgesStateAtom, newEdges);

    const selectedEdge = newEdges.find((e) => e.selected);
    if (selectedEdge) {
      set(selectedEdgeAtom, selectedEdge.id);
      set(selectedNodeAtom, null);
    } else if (get(selectedEdgeAtom)) {
      const currentSelection = get(selectedEdgeAtom);
      const stillExists = newEdges.find((e) => e.id === currentSelection);
      if (!stillExists) {
        set(selectedEdgeAtom, null);
      }
    }

    if (hasRemoval) {
      requestGraphSave(get, set, { immediate: true });
    }
  }
);

/**
 * Append a subgraph as one undo step: deselect what is on the canvas, select
 * the inserted nodes, and save. Paste, duplicate, and addNode all go through
 * here so the history / selection / save bookkeeping cannot drift.
 */
function insertClonedSubgraph(
  get: Getter,
  set: Setter,
  subgraph: CopiedSelection
) {
  const nodes = subgraph.nodes.map((node) => ({ ...node, selected: true }));
  const edges = subgraph.edges.map((edge) => ({ ...edge, selected: true }));

  pushHistory(get, set);
  set(nodesStateAtom, [
    ...get(nodesStateAtom).map((node) => ({ ...node, selected: false })),
    ...nodes,
  ]);
  set(edgesStateAtom, [
    ...get(edgesStateAtom).map((edge) => ({ ...edge, selected: false })),
    ...edges,
  ]);
  set(selectedNodeAtom, nodes[0].id);
  set(selectedEdgeAtom, null);

  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only?.data.type === "action" && !only.data.config?.actionType) {
    set(newlyCreatedNodeIdAtom, only.id);
  } else {
    set(newlyCreatedNodeIdAtom, null);
  }

  requestGraphSave(get, set, { immediate: true });
}

function snapshotCopyable(
  get: Getter,
  clickedNodeId?: string
): CopiedSelection | null {
  const nodes = get(nodesStateAtom);
  return extractCopyableSelection({
    nodes,
    edges: get(edgesStateAtom),
    nodeIds: clickedNodeId
      ? nodeIdsForContextCopy(nodes, clickedNodeId)
      : undefined,
  });
}

export const addNodeAtom = atom(null, (get, set, node: WorkflowNode) => {
  if (!draftEditable(get)) {
    return;
  }

  insertClonedSubgraph(get, set, { nodes: [node], edges: [] });
});

/** Whether Cmd+V / Paste have a copied subgraph to insert. */
export const hasCopiedSelectionAtom = atom(
  (get) => get(copiedSelectionAtom) !== null
);

/**
 * Snapshot the copyable selection for a later paste. `clickedNodeId` is the
 * node-context Copy target; omit it to copy whatever is selected. Selection
 * only, so not an undo step and not a save.
 */
export const copySelectionAtom = atom(
  null,
  (get, set, clickedNodeId?: string) => {
    const selection = snapshotCopyable(get, clickedNodeId);
    if (!selection) {
      return false;
    }

    set(copiedSelectionAtom, { selection, pasteCount: 0 });
    return true;
  }
);

/**
 * Insert the copied subgraph with fresh ids. One undo step, like addNode.
 *
 * `origin` places the copied bounding-box origin at a pane click; without it
 * each paste steps down-right from the original so repeats do not stack.
 */
export const pasteCopiedSelectionAtom = atom(
  null,
  (get, set, origin?: { x: number; y: number }) => {
    if (!draftEditable(get)) {
      return false;
    }

    const clipboard = get(copiedSelectionAtom);
    if (!clipboard) {
      return false;
    }

    const nextCount = clipboard.pasteCount + 1;
    const offset = origin
      ? offsetToOrigin(clipboard.selection.nodes, origin)
      : { x: PASTE_OFFSET * nextCount, y: PASTE_OFFSET * nextCount };

    set(copiedSelectionAtom, { ...clipboard, pasteCount: nextCount });
    insertClonedSubgraph(
      get,
      set,
      cloneSelection(clipboard.selection, { offset })
    );
    return true;
  }
);

/**
 * Clone the current (or context-clicked) selection in one undo step without
 * writing the clipboard, so a later paste still inserts whatever was copied.
 */
export const duplicateSelectionAtom = atom(
  null,
  (get, set, clickedNodeId?: string) => {
    if (!draftEditable(get)) {
      return false;
    }

    const selection = snapshotCopyable(get, clickedNodeId);
    if (!selection) {
      return false;
    }

    insertClonedSubgraph(
      get,
      set,
      cloneSelection(selection, {
        offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
      })
    );
    return true;
  }
);

/** Wrap a valid SESE lookup+Condition selection in a Group frame. */
export const groupSelectionAtom = atom(
  null,
  (get, set, clickedNodeId?: string) => {
    if (!draftEditable(get)) {
      return false;
    }

    const nodes = get(nodesStateAtom);
    const clicked = clickedNodeId
      ? nodes.find((node) => node.id === clickedNodeId)
      : undefined;
    const selectedIds =
      clickedNodeId && clicked && !clicked.selected
        ? new Set([clickedNodeId])
        : new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    const grouped = groupSelection({
      nodes,
      edges: get(edgesStateAtom),
      selectedIds,
    });
    if (!grouped) {
      return false;
    }

    pushHistory(get, set);
    set(nodesStateAtom, grouped.nodes);
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

/** Connect two nodes, recorded as an undo step like every graph mutation. */
export const connectNodesAtom = atom(null, (get, set, edge: WorkflowEdge) => {
  if (!draftEditable(get)) {
    return;
  }

  const nodes = get(nodesStateAtom);
  const sourceNode = nodes.find((node) => node.id === edge.source);
  const source = resolveStoredEndpoint(nodes, edge.source, "source");
  const target = resolveStoredEndpoint(nodes, edge.target, "target");
  let sourceHandle = edge.sourceHandle;
  if (isGroupNode(sourceNode)) {
    const exit = nodes.find((node) => node.id === groupExitId(sourceNode));
    if (isConditionNode(exit)) {
      sourceHandle = "true";
    }
  }

  pushHistory(get, set);
  set(edgesStateAtom, [
    ...get(edgesStateAtom),
    { ...edge, source, target, sourceHandle },
  ]);
  requestGraphSave(get, set, { immediate: true });
});

/** Apply auto-layout positions. Also an undo step, for the same reason. */
export const applyNodeLayoutAtom = atom(
  null,
  (get, set, nodes: WorkflowNode[]) => {
    if (!draftEditable(get)) {
      return;
    }

    pushHistory(get, set);
    set(nodesStateAtom, nodes);
    requestGraphSave(get, set, { immediate: true });
  }
);

/**
 * What `updateNodeDataAtom` accepts. `status` is omitted rather than merely
 * documented, so writing a run status into a node's own data is a compile
 * error at every call site, including the ones that take the setter straight
 * off the atom with `useSetAtom`.
 */
export type NodeDataUpdate = {
  id: string;
  data: Partial<Omit<WorkflowNodeData, "status">>;
};

/**
 * Write an edit into one node's data: label, description, config. Run status
 * does not travel through here -- it is never part of a node's own data, so
 * it has its own writer, `setNodeStatusesAtom`.
 */
export const updateNodeDataAtom = atom(
  null,
  (get, set, { id, data }: NodeDataUpdate) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);
    pushHistory(get, set);

    const oldNode = currentNodes.find((node) => node.id === id);
    const oldLabel = oldNode?.data.label;
    const newLabel = data.label;
    const isLabelChange = newLabel !== undefined && oldLabel !== newLabel;

    const newNodes = currentNodes.map((node) => {
      if (node.id === id) {
        return { ...node, data: { ...node.data, ...data } };
      }

      // A rename has to sweep every other node's config, because tokens carry
      // the label they were written against.
      if (isLabelChange && oldLabel) {
        const updatedConfig = updateTemplatesInConfig(
          node.data.config || {},
          id,
          oldLabel,
          newLabel
        );

        if (updatedConfig !== node.data.config) {
          return { ...node, data: { ...node.data, config: updatedConfig } };
        }
      }

      return node;
    });

    set(nodesStateAtom, newNodes);
    requestGraphSave(get, set);
  }
);

/**
 * Rewrite the label baked into every token that names `nodeId`.
 *
 * Tokens carry a label purely so the editor can show something readable, so a
 * rename has to sweep the configs that reference the renamed node. Tokens
 * already carrying the new label are left alone, which is what keeps a rename
 * from marking the workflow dirty when nothing actually moved.
 */
function updateTemplatesInConfig(
  config: Record<string, unknown>,
  nodeId: string,
  oldLabel: string,
  newLabel: string
): Record<string, unknown> {
  return mapTemplateTokens(config, (token) => {
    if (token.nodeId !== nodeId || token.nodeLabel !== oldLabel) {
      return undefined;
    }
    return formatTemplateToken({
      nodeId,
      nodeLabel: newLabel,
      fieldPath: token.fieldPath,
    });
  });
}

export const deleteNodeAtom = atom(null, (get, set, nodeId: string) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentNodes = get(nodesStateAtom);

  const nodeToDelete = currentNodes.find((node) => node.id === nodeId);
  if (nodeToDelete?.data.type === "lifecycle") {
    return;
  }

  pushHistory(get, set);

  const removed = idsRemovedWith(currentNodes, nodeId);
  const remainingNodes = dissolveUndersizedGroups(
    currentNodes.filter((node) => !removed.has(node.id))
  );
  set(nodesStateAtom, remainingNodes);
  set(
    edgesStateAtom,
    get(edgesStateAtom).filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target)
    )
  );

  if (get(selectedNodeAtom) && removed.has(get(selectedNodeAtom) ?? "")) {
    set(selectedNodeAtom, null);
  }

  requestGraphSave(get, set, { immediate: true });
});

export const deleteEdgeAtom = atom(null, (get, set, edgeId: string) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentEdges = get(edgesStateAtom);
  const remaining = currentEdges.filter((edge) => edge.id !== edgeId);
  if (remaining.length === currentEdges.length) {
    return;
  }

  pushHistory(get, set);
  set(edgesStateAtom, remaining);

  if (get(selectedEdgeAtom) === edgeId) {
    set(selectedEdgeAtom, null);
  }

  requestGraphSave(get, set, { immediate: true });
});

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentNodes = get(nodesStateAtom);
  const currentEdges = get(edgesStateAtom);
  const selectedNodeIds = new Set(
    currentNodes
      .filter((node) => node.selected && node.data.type !== "lifecycle")
      .map((node) => node.id)
  );
  for (const node of currentNodes) {
    if (node.parentId && selectedNodeIds.has(node.parentId)) {
      selectedNodeIds.add(node.id);
    }
  }

  // Lifecycle Nodes survive being selected; the graph needs an entrypoint.
  const remainingNodes = dissolveUndersizedGroups(
    currentNodes.filter(
      (node) => node.data.type === "lifecycle" || !selectedNodeIds.has(node.id)
    )
  );
  const remainingEdges = currentEdges.filter(
    (edge) =>
      !(
        edge.selected ||
        selectedNodeIds.has(edge.source) ||
        selectedNodeIds.has(edge.target)
      )
  );

  // Selecting only the Lifecycle Node and pressing delete removes nothing, and
  // an undo step for a change that did not happen is worse than no undo step.
  if (
    remainingNodes.length === currentNodes.length &&
    remainingEdges.length === currentEdges.length
  ) {
    return;
  }

  pushHistory(get, set);
  set(nodesStateAtom, remainingNodes);
  set(edgesStateAtom, remainingEdges);
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);

  requestGraphSave(get, set, { immediate: true });
});

/**
 * Strip the workflow back to its Lifecycle Node.
 *
 * The Lifecycle Node survives, the same way it survives every other delete
 * path: the server rejects a graph with no Lifecycle Node, so wiping the
 * canvas outright produced something that could never be saved.
 */
export const clearWorkflowAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentNodes = get(nodesStateAtom);
  const lifecycleNodes = currentNodes.filter(
    (node) => node.data.type === "lifecycle"
  );
  if (
    lifecycleNodes.length === currentNodes.length &&
    get(edgesStateAtom).length === 0
  ) {
    return;
  }

  pushHistory(get, set);
  set(nodesStateAtom, lifecycleNodes);
  // Every edge had at least one end on a removed node.
  set(edgesStateAtom, []);
  set(selectedNodeAtom, null);
  set(selectedEdgeAtom, null);

  requestGraphSave(get, set, { immediate: true });
});

export const undoAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const history = get(historyAtom);
  const previousState = history.at(-1);
  if (!previousState) {
    return;
  }

  set(futureAtom, [
    ...get(futureAtom),
    { nodes: get(nodesStateAtom), edges: get(edgesStateAtom) },
  ]);
  set(historyAtom, history.slice(0, -1));
  set(nodesStateAtom, previousState.nodes);
  set(edgesStateAtom, previousState.edges);

  requestGraphSave(get, set, { immediate: true });
});

export const redoAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const future = get(futureAtom);
  const nextState = future.at(-1);
  if (!nextState) {
    return;
  }

  set(historyAtom, [
    ...get(historyAtom),
    { nodes: get(nodesStateAtom), edges: get(edgesStateAtom) },
  ]);
  set(futureAtom, future.slice(0, -1));
  set(nodesStateAtom, nextState.nodes);
  set(edgesStateAtom, nextState.edges);

  requestGraphSave(get, set, { immediate: true });
});

export const canUndoAtom = atom((get) => get(historyAtom).length > 0);
export const canRedoAtom = atom((get) => get(futureAtom).length > 0);

/** Reset run badges. Execution state, so it neither dirties nor saves. */
export const clearNodeStatusesAtom = atom(null, (_get, set) => {
  // Deleting runs (the only caller) must also drop the run overlay so the
  // canvas returns to the draft rather than painting statuses on a gone run.
  set(executionOverlayGraphAtom, null);
  set(statusByNodeIdAtom, new Map());
});

/**
 * Drop every recorded status without touching the overlay.
 *
 * The server's status list is not exhaustive -- it names only the nodes that
 * have an execution-log row for the run being read -- so switching straight
 * from one open run to another has to clear what the first run left behind
 * before the second run's statuses land. Leaving a stale entry in place would
 * have a node the new run never reached go on reporting what the old run did.
 * `clearNodeStatusesAtom` also drops the overlay, which is wrong here: the
 * overlay for the new run is what workflow-runs.tsx's sync effect sets up
 * next, in the same pass.
 */
export const resetNodeStatusesAtom = atom(null, (_get, set) => {
  set(statusByNodeIdAtom, new Map());
});

/**
 * Record a run's progress. Merged onto whichever graph `displayNodesAtom` is
 * showing -- there is no branch here for the overlay versus the draft,
 * because a status is display-time state, not graph state.
 */
export const setNodeStatusesAtom = atom(
  null,
  (get, set, statuses: Array<{ nodeId: string; status: NodeRunStatus }>) => {
    if (statuses.length === 0) {
      return;
    }

    const current = get(statusByNodeIdAtom);
    const next = new Map(current);
    let hasUpdates = false;
    for (const { nodeId, status } of statuses) {
      if (current.get(nodeId) !== status) {
        next.set(nodeId, status);
        hasUpdates = true;
      }
    }

    if (hasUpdates) {
      set(statusByNodeIdAtom, next);
    }
  }
);
