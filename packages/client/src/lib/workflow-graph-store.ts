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
  lastSavedAtAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  successfulSaveGenerationAtom,
  workflowNotFoundAtom,
  workflowLoadErrorAtom,
} from "#src/lib/workflow-save-store";
import {
  activeAgentTurnIdAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { clearPublicationReviewAtom } from "#src/lib/workflow-publication-review-store";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import { NO_ISSUES, workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  dissolveUndersizedGroups,
  dropOrphanedEdges,
  expandEdgeRemovals,
  idsRemovedWith,
  refuseDeleteWithNotice,
} from "#src/lib/node-group";
import {
  canonicalizeNodeEnabled,
  persistedNodeEnabled,
} from "@wfgraph/shared/graph/node-enabled";
import {
  fanOutStoreEdgeIds,
  orderGroupParentsFirst,
} from "@wfgraph/shared/graph/node-group";
import {
  draftEditable,
  edgesStateAtom,
  executionOverlayGraphAtom,
  futureAtom,
  historyAtom,
  nodesStateAtom,
  pushHistory,
  requestGraphSave,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
import {
  clearWorkflowComparisonAtom,
  comparisonSessionAtom,
} from "#src/lib/workflow-comparison-store";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { resetNodeStatusesAtom as resetPresentationNodeStatusesAtom } from "#src/lib/workflow-graph-presentation-store";

export {
  executionOverlayGraphAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
export {
  connectNodesAtom,
  deleteEdgeAtom,
  groupSelectionAtom,
  setGroupEnabledAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-group-store";
export {
  canvasEditingLockedAtom,
  clearNodeStatusesAtom,
  displayEdgesAtom,
  displayNodesAtom,
  isExecutionOverlayActiveAtom,
  resetNodeStatusesAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-presentation-store";

/**
 * The graph the editor is showing, and every operation that may change it.
 *
 * The node and edge cells live in workflow-graph-cells and stay unexported
 * from this module. A write that skipped an operation here would skip undo.
 * Exporting only read-only views makes that mistake fail to compile, because
 * jotai types the setter of a read-only atom as `never`.
 *
 * Add an operation here rather than reaching for the cells.
 */

/** Read-only draft. Mutate through the action atoms below so undo always sees it. */
export const nodesAtom = atom((get) => get(nodesStateAtom));
export const edgesAtom = atom((get) => get(edgesStateAtom));

// Tracks a just-created node so the config panel can focus its search input.
// Cleared once the node gets an action type or loses selection.
export const newlyCreatedNodeIdAtom = atom<string | null>(null);

type CopiedClipboard = {
  selection: CopiedSelection;
  pasteCount: number;
};

const copiedSelectionAtom = atom<CopiedClipboard | null>(null);

// Whether a node drag is mid-flight, so the whole drag records one undo step
// rather than one per frame.
const isDraggingAtom = atom(false);

/**
 * Replace the graph with what came back from the server.
 *
 * Clearing history is the point: undo history surviving a navigation between
 * workflows would let pressing undo after switching write the previous
 * workflow's graph into the current one, which autosave would then persist
 * under the wrong id.
 *
 * Nodes are stored rest → frames → members so `displayNodesAtom` can return
 * this array on a canvas read instead of reallocating through
 * `orderGroupParentsFirst` on every drag frame.
 */
export const loadWorkflowGraphAtom = atom(
  null,
  (get, set, graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => {
    const workflowId = get(currentWorkflowIdAtom);
    if (workflowId) {
      set(clearWorkflowComparisonAtom, workflowId);
    }
    set(nodesStateAtom, orderGroupParentsFirst(graph.nodes));
    set(edgesStateAtom, graph.edges);
    set(historyAtom, []);
    set(futureAtom, []);
    set(selectedNodeAtom, null);
    set(selectedEdgeAtom, null);
    set(newlyCreatedNodeIdAtom, null);
    set(hasUnsavedChangesAtom, false);
    // Issues name the node ids of the graph being replaced. The collector is
    // debounced, so leaving them would let the toolbar chip count the previous
    // workflow's faults against this one until the next settle, and the badges
    // it claims to agree with would already be gone.
    set(workflowIssuesAtom, NO_ISSUES);
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
  (get, set, workflow: SavedWorkflow & { saveGeneration?: number }) => {
    // A loader can hold an older server snapshot while a save completes. The
    // save clears both guards used below, so compare the loader's start
    // generation before changing any editor state.
    if (
      workflow.saveGeneration !== undefined &&
      (get(successfulSaveGenerationAtom).get(workflow.id) ?? 0) >
        workflow.saveGeneration
    ) {
      return;
    }

    // Hydration starts a new editor lifetime even when the route resolves the
    // same workflow again. A comparison snapshot belongs to the lifetime that
    // requested it and must not lock the newly loaded draft.
    set(clearWorkflowComparisonAtom, workflow.id);
    set(clearPublicationReviewAtom);
    // Clearing selection stops a node from arriving pre-selected in a
    // workflow the user has just opened.
    const nodes = workflow.nodes.map((node) => ({
      ...node,
      selected: false,
    }));

    // Reopening the workflow already on screen must not overwrite edits the
    // server has not stored. A failed save leaves the dirty flag raised on
    // purpose, so without this a later route re-run installs the server's older
    // graph and lowers the flag, dropping the edit and the failure notice with
    // it. Route re-runs are routine: selecting a run writes `executionId` into
    // the search and leaving Runs clears it, each one refetching the workflow.
    // The same guard covers a read that overtakes a write still in flight,
    // where the reverted graph stays on screen while the write lands.
    //
    // A different workflow always replaces the graph, and so does this one once
    // the queue has drained and the two agree.
    const clientIsAheadOfServer =
      get(currentWorkflowIdAtom) === workflow.id &&
      (get(hasUnsavedChangesAtom) || get(isSavingAtom));

    // Also clears undo history, so undo cannot reach back past the switch and
    // write the previous workflow's graph into this one.
    if (!clientIsAheadOfServer) {
      set(loadWorkflowGraphAtom, { nodes, edges: workflow.edges });
    }
    // Overlay, selection and statuses belong to the open run. Switching
    // workflows has to drop them — a reused node id would otherwise keep the
    // previous run's badges. Reloading the same workflow (dashboard round-trip,
    // stale-while-revalidate) must not: wiping them is how a waiting canvas
    // lost its animation while the Runs panel still showed the run.
    if (get(currentWorkflowIdAtom) !== workflow.id) {
      const preserveDeepLinkedRun =
        get(workflowWorkspaceViewAtom) === "runs" &&
        get(selectedExecutionIdAtom) !== null;
      set(resetPresentationNodeStatusesAtom);
      set(executionOverlayGraphAtom, null);
      set(selectedExecutionIdAtom, null);
      set(workflowWorkspaceViewAtom, preserveDeepLinkedRun ? "runs" : "draft");
    }
    set(activeAgentTurnIdAtom, null);
    set(isGeneratingAtom, false);
    set(currentWorkflowIdAtom, workflow.id);
    set(currentWorkflowNameAtom, workflow.name);
    // The clock reading belongs to the workflow just left, so the strip would
    // otherwise open this one on a save that happened to a different graph.
    set(lastSavedAtAtom, null);
    set(currentWorkflowVisibilityAtom, workflow.visibility ?? "private");
    set(currentWorkflowModeAtom, workflow.mode ?? "live");
    set(workflowNotFoundAtom, false);
    set(workflowLoadErrorAtom, null);
  }
);

/**
 * Install a restored workflow only while the editor still shows that workflow.
 * A restore request can finish after navigation, so this guard owns the graph
 * write and comparison cleanup together rather than leaving each caller to race.
 */
export const installRestoredWorkflowAtom = atom(
  null,
  (
    get,
    set,
    input: { expectedWorkflowId: string; workflow: SavedWorkflow }
  ) => {
    if (
      get(currentWorkflowIdAtom) !== input.expectedWorkflowId ||
      input.workflow.id !== input.expectedWorkflowId
    ) {
      return false;
    }
    set(loadWorkflowGraphAtom, {
      nodes: input.workflow.nodes,
      edges: input.workflow.edges,
    });
    return true;
  }
);

/**
 * Return from a comparison without making selection a graph edit. A historical
 * node may not exist in the draft, while a draft node becomes its sole selection.
 */
export const exitWorkflowComparisonAtom = atom(null, (get, set) => {
  const workflowId = get(currentWorkflowIdAtom);
  if (!workflowId || !get(comparisonSessionAtom)) {
    return false;
  }
  const selectedNodeId = get(selectedNodeAtom);
  const draftSelection = selectedNodeId
    ? (get(nodesStateAtom).find((node) => node.id === selectedNodeId)?.id ??
      null)
    : null;
  set(
    nodesStateAtom,
    get(nodesStateAtom).map((node) => ({
      ...node,
      selected: node.id === draftSelection,
    }))
  );
  set(selectedNodeAtom, draftSelection);
  set(selectedEdgeAtom, null);
  set(clearWorkflowComparisonAtom, workflowId);
  return true;
});

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

    // A removal here can strand an edge React Flow never offered to delete;
    // `dropOrphanedEdges` says which and why. It answers the same array when
    // there is nothing to drop, and jotai skips a write of the value it holds.
    if (hasRemoval) {
      const remainingEdges = dropOrphanedEdges(newNodes, get(edgesStateAtom));
      set(edgesStateAtom, remainingEdges);
      // The paths that remove an edge clear the selection naming it, and this
      // one answers to the same rule even though today's stranded edges are all
      // unselectable.
      const selectedEdge = get(selectedEdgeAtom);
      if (selectedEdge && !remainingEdges.some((e) => e.id === selectedEdge)) {
        set(selectedEdgeAtom, null);
      }
    }

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
    const currentEdges = get(edgesStateAtom);
    const expandedChanges = expandEdgeRemovals(
      get(nodesStateAtom),
      currentEdges,
      changes
    );
    const newEdges = applyEdgeChanges(expandedChanges, currentEdges);
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
  // Sorted like the other two writers: a cloned frame appended after the
  // members already on the canvas costs `displayNodesAtom` its fast path.
  set(
    nodesStateAtom,
    orderGroupParentsFirst([
      ...get(nodesStateAtom).map((node) => ({ ...node, selected: false })),
      ...nodes,
    ])
  );
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

/**
 * Put the build agent's version of the workflow on the canvas.
 *
 * The caller marks the first graph in a turn as its undo boundary. The agent
 * chooses no coordinates, so every node it added arrives at the origin and the
 * layout pass here is what places new nodes.
 *
 * Node identity is preserved for anything the agent left alone: `displayNodesAtom`
 * keeps a paint cache keyed on it, so rebuilding every node would re-render every
 * card on the canvas for an edit that touched one.
 */
export const applyAgentGraphAtom = atom(
  null,
  (
    get,
    set,
    input: {
      workflowId: string;
      turnId: symbol;
      recordHistory: boolean;
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      catalog: ExtensionCatalog;
    }
  ) => {
    if (
      input.workflowId !== get(currentWorkflowIdAtom) ||
      input.turnId !== get(activeAgentTurnIdAtom) ||
      !draftEditable(get)
    ) {
      return false;
    }

    const existingById = new Map(
      get(nodesStateAtom).map((node) => [node.id, node] as const)
    );

    // The agent chooses no coordinates, so the position it sends is absence
    // rather than a move. Carrying the one already on screen forward is what
    // stops the layout below reflowing the whole canvas around one edited step.
    const placed = input.nodes.map((node) => {
      const existing = existingById.get(node.id);
      return existing ? { ...node, position: existing.position } : node;
    });

    const { nodes: laidOut } = layoutWorkflowNodes({
      nodes: placed,
      edges: input.edges,
      catalog: input.catalog,
    });

    const positioned = laidOut.map((node) => {
      const existing = existingById.get(node.id);
      return existing ? { ...node, position: existing.position } : node;
    });

    // `layoutWorkflowNodes` rebuilds every node it is given, so identity is
    // restored here rather than assumed. `displayNodesAtom` keeps a paint cache
    // keyed on it, and a turn calls several write tools, each sending the whole
    // graph back: without this every card on the canvas repaints per tool call.
    const reconciled = positioned.map((node) => {
      const existing = existingById.get(node.id);
      return existing && isSameNode(existing, node) ? existing : node;
    });

    if (input.recordHistory) {
      pushHistory(get, set);
    }
    set(nodesStateAtom, orderGroupParentsFirst(reconciled));
    set(edgesStateAtom, input.edges);
    requestGraphSave(get, set, { immediate: true });
    return true;
  }
);

/** Whether the agent's node is, in every way the canvas paints, the one already there. */
function isSameNode(existing: WorkflowNode, incoming: WorkflowNode): boolean {
  return (
    existing.type === incoming.type &&
    existing.parentId === incoming.parentId &&
    existing.position.x === incoming.position.x &&
    existing.position.y === incoming.position.y &&
    existing.data.label === incoming.data.label &&
    existing.data.description === incoming.data.description &&
    persistedNodeEnabled(existing.data.enabled) ===
      persistedNodeEnabled(incoming.data.enabled) &&
    JSON.stringify(existing.data.config ?? {}) ===
      JSON.stringify(incoming.data.config ?? {})
  );
}

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
        return {
          ...node,
          data: canonicalizeNodeEnabled({ ...node.data, ...data }),
        };
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
  if (nodeToDelete && refuseDeleteWithNotice([nodeToDelete])) {
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

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentNodes = get(nodesStateAtom);
  const currentEdges = get(edgesStateAtom);
  // The delete key asks the same question through `onBeforeDelete`, so a
  // selection reaching into a frame without taking the frame is refused whole
  // here too rather than quietly losing the member and taking the rest.
  const selectedNodes = currentNodes.filter((node) => node.selected);
  if (refuseDeleteWithNotice(selectedNodes)) {
    return;
  }

  const selectedNodeIds = new Set(
    selectedNodes
      .filter((node) => node.data.type !== "lifecycle")
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
  const selectedFanOut = new Set(
    currentEdges
      .filter((edge) => edge.selected)
      .flatMap((edge) =>
        fanOutStoreEdgeIds(currentNodes, currentEdges, edge.id)
      )
  );
  const remainingEdges = currentEdges.filter(
    (edge) =>
      !selectedFanOut.has(edge.id) &&
      !selectedNodeIds.has(edge.source) &&
      !selectedNodeIds.has(edge.target)
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
