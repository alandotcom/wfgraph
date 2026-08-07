import type { EdgeChange, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import { repairNodeIntegrations } from "#src/lib/node-integration";
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
} from "#src/lib/workflow-save-store";
import {
  isGeneratingAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import {
  formatTemplateToken,
  parseTemplate,
} from "@rova/shared/graph/node-references";
import { inactiveCanceledBranch } from "#src/lib/inactive-canceled-branch";
import type {
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

/**
 * The published graph a selected run pinned, shown on the canvas instead of the
 * draft so node statuses land on the shape the run actually walked. Cleared
 * when the run is deselected. Never saved: draft atoms stay draft-only so a
 * Cmd+S or toolbar save cannot persist the run graph over the editor's draft.
 */
export const executionOverlayGraphAtom = atom<{
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} | null>(null);

/** Read-only draft. Mutate through the action atoms below so undo always sees it. */
export const nodesAtom = atom((get) => get(nodesStateAtom));
export const edgesAtom = atom((get) => get(edgesStateAtom));

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
  const { nodeIds } = get(inactiveCanceledBranchAtom);
  if (nodeIds.size === 0) {
    return nodes;
  }
  return nodes.map((node) =>
    nodeIds.has(node.id)
      ? {
          ...node,
          style: { ...node.style, ...INACTIVE_NODE_STYLE },
        }
      : node
  );
});
export const displayEdgesAtom = atom((get) => {
  const edges = get(executionOverlayGraphAtom)?.edges ?? get(edgesStateAtom);
  const { edgeIds, outletEdgeIds } = get(inactiveCanceledBranchAtom);
  if (edgeIds.size === 0) {
    return edges;
  }
  return edges.map((edge) => {
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

/** Hand the current nodes and edges to the save queue, which owns the flags. */
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
    // Statuses belong to a run, not to the workflow, so a freshly loaded graph
    // shows none of the previous run's progress. Clearing selection stops a
    // node from arriving pre-selected in a workflow the user has just opened.
    const nodes = workflow.nodes.map((node) => ({
      ...node,
      selected: false,
      data: { ...node.data, status: "idle" as const },
    }));

    // Also clears undo history, so undo cannot reach back past the switch and
    // write the previous workflow's graph into this one.
    set(loadWorkflowGraphAtom, { nodes, edges: workflow.edges });
    set(executionOverlayGraphAtom, null);
    set(selectedExecutionIdAtom, null);
    set(currentWorkflowIdAtom, workflow.id);
    set(currentWorkflowNameAtom, workflow.name);
    set(currentWorkflowVisibilityAtom, workflow.visibility ?? "private");
    set(currentWorkflowModeAtom, workflow.mode ?? "live");
    set(isWorkflowOwnerAtom, workflow.isOwner !== false);
    set(workflowNotFoundAtom, false);
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
  (get, set, integrations: readonly { id: string; type: string }[]) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);
    const repaired = repairNodeIntegrations(currentNodes, integrations);

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

    const newNodes = applyNodeChanges<WorkflowNode>(
      filteredChanges,
      currentNodes
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

export const addNodeAtom = atom(null, (get, set, node: WorkflowNode) => {
  if (!draftEditable(get)) {
    return;
  }

  pushHistory(get, set);

  const updatedNodes = get(nodesStateAtom).map((n) => ({
    ...n,
    selected: false,
  }));
  set(nodesStateAtom, [...updatedNodes, { ...node, selected: true }]);
  set(selectedNodeAtom, node.id);

  // A brand new action node has no action picked yet, so the panel opens on its
  // search input rather than on an empty config form.
  if (node.data.type === "action" && !node.data.config?.actionType) {
    set(newlyCreatedNodeIdAtom, node.id);
  }

  requestGraphSave(get, set, { immediate: true });
});

/** Connect two nodes, recorded as an undo step like every graph mutation. */
export const connectNodesAtom = atom(null, (get, set, edge: WorkflowEdge) => {
  if (!draftEditable(get)) {
    return;
  }

  pushHistory(get, set);
  set(edgesStateAtom, [...get(edgesStateAtom), edge]);
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

export const updateNodeDataAtom = atom(
  null,
  (get, set, { id, data }: { id: string; data: Partial<WorkflowNodeData> }) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);

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

    // A status change is execution progress, not an edit, so it neither dirties
    // the workflow nor triggers a save.
    if (!data.status) {
      requestGraphSave(get, set);
    }
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
  let hasChanges = false;
  const updated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      updated[key] = parseTemplate(value)
        .map((segment) => {
          if (segment.kind === "literal") {
            return segment.text;
          }

          const { token } = segment;
          if (token.nodeId !== nodeId || token.nodeLabel !== oldLabel) {
            return token.raw;
          }

          hasChanges = true;
          return formatTemplateToken({
            nodeId,
            nodeLabel: newLabel,
            fieldPath: token.fieldPath,
          });
        })
        .join("");
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // The recursion needs a keyed value to walk. The copy is what gets passed
      // down, so it is also what the identity check below compares against: the
      // recursion returns its own argument when nothing inside it was renamed.
      const nested: Record<string, unknown> = { ...value };
      const nestedUpdated = updateTemplatesInConfig(
        nested,
        nodeId,
        oldLabel,
        newLabel
      );
      if (nestedUpdated !== nested) {
        hasChanges = true;
      }
      updated[key] = nestedUpdated;
    } else {
      updated[key] = value;
    }
  }

  return hasChanges ? updated : config;
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

  set(
    nodesStateAtom,
    currentNodes.filter((node) => node.id !== nodeId)
  );
  set(
    edgesStateAtom,
    get(edgesStateAtom).filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId
    )
  );

  if (get(selectedNodeAtom) === nodeId) {
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

  // Lifecycle Nodes survive being selected; the graph needs an entrypoint.
  const remainingNodes = currentNodes.filter(
    (node) => node.data.type === "lifecycle" || !node.selected
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
export const clearNodeStatusesAtom = atom(null, (get, set) => {
  // Deleting runs (the only caller) must also drop the run overlay so the
  // canvas returns to the draft rather than painting statuses on a gone run.
  set(executionOverlayGraphAtom, null);
  set(
    nodesStateAtom,
    get(nodesStateAtom).map((node) => ({
      ...node,
      data: { ...node.data, status: "idle" as const },
    }))
  );
});

export const setNodeStatusesAtom = atom(
  null,
  (
    get,
    set,
    statuses: Array<{
      nodeId: string;
      status: "idle" | "running" | "success" | "error" | "cancelled";
    }>
  ) => {
    if (statuses.length === 0) {
      return;
    }

    const statusByNodeId = new Map(
      statuses.map((statusEntry) => [statusEntry.nodeId, statusEntry.status])
    );

    const applyStatuses = (nodes: WorkflowNode[]) => {
      let hasUpdates = false;
      const nextNodes = nodes.map((node) => {
        const nextStatus = statusByNodeId.get(node.id);
        if (!nextStatus || node.data.status === nextStatus) {
          return node;
        }

        hasUpdates = true;
        return { ...node, data: { ...node.data, status: nextStatus } };
      });
      return hasUpdates ? nextNodes : null;
    };

    // Statuses belong on the graph the canvas is showing.
    const overlay = get(executionOverlayGraphAtom);
    if (overlay) {
      const nextNodes = applyStatuses(overlay.nodes);
      if (nextNodes) {
        set(executionOverlayGraphAtom, { ...overlay, nodes: nextNodes });
      }
      return;
    }

    const nextNodes = applyStatuses(get(nodesStateAtom));
    if (nextNodes) {
      set(nodesStateAtom, nextNodes);
    }
  }
);
