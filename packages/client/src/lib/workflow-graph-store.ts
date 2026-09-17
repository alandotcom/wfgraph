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
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeAgentTurnIdAtom,
  workflowGraphUpdateAtom,
} from "#src/lib/workflow-ui-store";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import {
  expandEdgeRemovals,
  removeNodes,
  repairCanvasGroups,
} from "#src/lib/node-group";
import { getClientLogger } from "#src/lib/logger";
import {
  canonicalizeNodeEnabled,
  persistedNodeEnabled,
} from "@wfgraph/shared/graph/node-enabled";
import {
  fanOutStoreEdgeIds,
  orderGroupParentsFirst,
} from "@wfgraph/shared/graph/node-group";
import { omit } from "es-toolkit/object";
import {
  draftEditable,
  edgesStateAtom,
  futureAtom,
  historyAtom,
  nodesStateAtom,
  pushHistory,
  requestGraphSave,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import {
  newlyCreatedNodeIdAtom,
  workflowDragActiveAtom,
} from "#src/lib/workflow-graph-session-store";
import {
  EMPTY_SELECTION,
  selectionInGraph,
  selectionWithChanges,
  type SelectionChange,
} from "#src/lib/workflow-navigation-state";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";

export {
  executionOverlayGraphAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
export {
  connectNodesAtom,
  deleteEdgeAtom,
  deleteGroupWithMembersAtom,
  groupSelectionAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-group-store";
export {
  canvasEditingLockedAtom,
  canvasEdgesAtom,
  canvasGraphAtom,
  canvasNodesAtom,
  clearNodeStatusesAtom,
  displayNodesAtom,
  isExecutionOverlayActiveAtom,
  presentedGraphAtom,
  presentedGraphStructureAtom,
  resetNodeStatusesAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-presentation-store";
export {
  endWorkflowEditorLifetimeAtom,
  hydrateWorkflowAtom,
  installRemoteWorkflowAtom,
  installRestoredWorkflowAtom,
  loadWorkflowGraphAtom,
  newlyCreatedNodeIdAtom,
  observedRemoteDraftRevisionAtom,
  recordObservedRemoteDraftRevisionAtom,
  remoteDraftChangeAtom,
  remoteWorkflowUpdateDispositionAtom,
} from "#src/lib/workflow-graph-session-store";

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

const logger = getClientLogger("workflow", "graph");

type CopiedClipboard = {
  selection: CopiedSelection;
  pasteCount: number;
};

const copiedSelectionAtom = atom<CopiedClipboard | null>(null);

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

/**
 * The selected nodes and edges of the active workspace address, whichever
 * graph it presents. Write through `selectOnlyNodeAtom`, `clearSelectionAtom`,
 * or the React Flow change handlers.
 */
export const canvasSelectionAtom = atom((get) => get(activeSelectionAtom));

/**
 * Make one displayed node the only selection of the active address. Selection
 * stays out of history and saves, and may change while the Draft is read-only.
 */
export const selectOnlyNodeAtom = atom(null, (_get, set, nodeId: string) => {
  set(activeSelectionAtom, { nodeIds: [nodeId], edgeIds: [] });
});

/** Select nothing in the active address. */
export const clearSelectionAtom = atom(null, (_get, set) => {
  set(activeSelectionAtom, EMPTY_SELECTION);
});

/** The React Flow `select` changes in a batch of node or edge changes. */
function selectChanges(
  changes: readonly (NodeChange<WorkflowNode> | EdgeChange)[]
): SelectionChange[] {
  return changes.flatMap((change) =>
    change.type === "select"
      ? [{ id: change.id, selected: change.selected }]
      : []
  );
}

/** Drop the ids the Draft graph no longer holds from the active selection. */
function keepSelectionInDraft(get: Getter, set: Setter) {
  set(
    activeSelectionAtom,
    selectionInGraph(get(activeSelectionAtom), {
      nodes: get(nodesStateAtom),
      edges: get(edgesStateAtom),
    })
  );
}

export const onNodesChangeAtom = atom(
  null,
  (get, set, changes: NodeChange<WorkflowNode>[]) => {
    // Selection is stored per workspace address, so it may change while the
    // Draft is read-only, and the graph cells hold no `selected` flag.
    set(
      activeSelectionAtom,
      selectionWithChanges(get(activeSelectionAtom), {
        nodes: selectChanges(changes),
      })
    );

    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);

    // Lifecycle Nodes are the workflow's entrypoint; the graph is invalid
    // without one, so drop any attempt to remove them.
    const filteredChanges = changes.filter((change) => {
      if (change.type === "select") {
        return false;
      }
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
    if (isDragFrame && !get(workflowDragActiveAtom)) {
      // A drag arrives as a stream of frames. Only the first still has the
      // pre-drag positions worth snapshotting.
      pushHistory(get, set);
      set(workflowDragActiveAtom, true);
    }

    if (isDragSettled) {
      set(workflowDragActiveAtom, false);
    }

    if (filteredChanges.length > 0) {
      const changedNodes = applyNodeChanges<WorkflowNode>(
        filteredChanges.filter((change) => change.type !== "remove"),
        currentNodes
      );
      // Removals go through `removeNodes`, which every delete path shares. It
      // removes the stored edges React Flow never offered to delete, such as a
      // member's locked interior edges, ungroups a removed frame, and ungroups
      // a frame the removal leaves holding fewer than two steps, all inside the
      // undo step `snapshotHistoryAtom` recorded. A drag removes nothing and
      // skips it.
      const removal = hasRemoval
        ? removeNodes({
            nodes: changedNodes,
            edges: get(edgesStateAtom),
            nodeIds: new Set(
              filteredChanges.flatMap((change) =>
                change.type === "remove" ? [change.id] : []
              )
            ),
          })
        : undefined;
      set(nodesStateAtom, removal?.nodes ?? changedNodes);

      // `removeNodes` answers the same edge array when it removed no edge, and
      // jotai skips a write of the value it already holds.
      if (removal) {
        set(edgesStateAtom, removal.edges);
        keepSelectionInDraft(get, set);
      }
    }

    // The config panel focuses a new node only while it is the one selection.
    const newlyCreatedId = get(newlyCreatedNodeIdAtom);
    if (newlyCreatedId && get(selectedNodeAtom) !== newlyCreatedId) {
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
    set(
      activeSelectionAtom,
      selectionWithChanges(get(activeSelectionAtom), {
        edges: selectChanges(changes),
      })
    );

    if (!draftEditable(get)) {
      return;
    }

    // No history push here; see the note in onNodesChangeAtom.
    const graphChanges = changes.filter((change) => change.type !== "select");
    if (graphChanges.length === 0) {
      return;
    }
    const hasRemoval = graphChanges.some((change) => change.type === "remove");
    const currentEdges = get(edgesStateAtom);
    const expandedChanges = expandEdgeRemovals(
      get(nodesStateAtom),
      currentEdges,
      graphChanges
    );
    set(edgesStateAtom, applyEdgeChanges(expandedChanges, currentEdges));

    if (hasRemoval) {
      keepSelectionInDraft(get, set);
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
  const nodes = subgraph.nodes.map((node) => omit(node, ["selected"]));
  const edges = subgraph.edges.map((edge) => omit(edge, ["selected"]));

  pushHistory(get, set);
  // Sorted like the other two writers: a cloned frame appended after the
  // members already on the canvas costs `displayNodesAtom` its fast path.
  set(
    nodesStateAtom,
    orderGroupParentsFirst([...get(nodesStateAtom), ...nodes])
  );
  set(edgesStateAtom, [...get(edgesStateAtom), ...edges]);
  // The inserted top-level nodes and the edges between them become the
  // selection. A pasted Group is selected as its frame, which carries its
  // members, so a single pasted Group opens in the inspector.
  const insertedIds = new Set(nodes.map((node) => node.id));
  const topLevelIds = new Set(
    nodes
      .filter((node) => !node.parentId || !insertedIds.has(node.parentId))
      .map((node) => node.id)
  );
  set(activeSelectionAtom, {
    nodeIds: [...topLevelIds],
    edgeIds: edges
      .filter(
        (edge) => topLevelIds.has(edge.source) && topLevelIds.has(edge.target)
      )
      .map((edge) => edge.id),
  });

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
  const selectedIds = new Set(get(activeSelectionAtom).nodeIds);
  return extractCopyableSelection({
    nodes,
    edges: get(edgesStateAtom),
    nodeIds: clickedNodeId
      ? nodeIdsForContextCopy(nodes, clickedNodeId, selectedIds)
      : selectedIds,
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
 * chooses no coordinates, so every graph update gets a complete layout pass.
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

    // The graph arrives from the server, so it is held to the Group rules
    // before it can reach the canvas or the save below. A graph whose Group
    // structure a draft save would refuse is left off the canvas, and a Group
    // holding fewer than two steps is ungrouped.
    const repair = repairCanvasGroups({
      nodes: input.nodes,
      edges: input.edges,
    });
    if (!repair.ok) {
      logger.error("Agent graph refused for its Group structure", {
        workflowId: input.workflowId,
      });
      return false;
    }

    const existingById = new Map(
      get(nodesStateAtom).map((node) => [node.id, node] as const)
    );

    const { nodes: laidOut } = layoutWorkflowNodes({
      nodes: repair.nodes,
      edges: input.edges,
      catalog: input.catalog,
    });

    // `layoutWorkflowNodes` rebuilds every node it is given, so identity is
    // restored here rather than assumed. `displayNodesAtom` keeps a paint cache
    // keyed on it, and a turn calls several write tools, each sending the whole
    // graph back: without this every card on the canvas repaints per tool call.
    const reconciled = laidOut.map((node) => {
      const existing = existingById.get(node.id);
      return existing && isSameNode(existing, node) ? existing : node;
    });

    if (input.recordHistory) {
      pushHistory(get, set);
    }
    set(nodesStateAtom, orderGroupParentsFirst(reconciled));
    set(edgesStateAtom, input.edges);
    // The agent's graph can drop a selected step, and the repair can dissolve
    // a selected frame.
    keepSelectionInDraft(get, set);
    set(workflowGraphUpdateAtom, {
      workflowId: input.workflowId,
      revision: (get(workflowGraphUpdateAtom)?.revision ?? 0) + 1,
    });
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
  const currentEdges = get(edgesStateAtom);

  // A frame is ungrouped and keeps its members, a step goes with its stored
  // edges, and a frame left holding fewer than two steps is ungrouped.
  const next = removeNodes({
    nodes: currentNodes,
    edges: currentEdges,
    nodeIds: new Set([nodeId]),
  });
  if (next.nodes === currentNodes && next.edges === currentEdges) {
    return;
  }

  pushHistory(get, set);
  set(nodesStateAtom, next.nodes);
  set(edgesStateAtom, next.edges);

  // The selection can name the deleted step, a frame the delete ungrouped, or
  // a frame dissolved because the delete left it too small.
  keepSelectionInDraft(get, set);

  requestGraphSave(get, set, { immediate: true });
});

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
  if (!draftEditable(get)) {
    return;
  }

  const currentNodes = get(nodesStateAtom);
  const currentEdges = get(edgesStateAtom);
  const selection = get(activeSelectionAtom);

  // `removeNodes` keeps the Lifecycle Node, which the graph needs as its
  // entrypoint, removes the selected steps, ungroups a selected frame, and
  // ungroups a frame the removal leaves holding fewer than two steps.
  const selectedFanOut = new Set(
    selection.edgeIds.flatMap((edgeId) =>
      fanOutStoreEdgeIds(currentNodes, currentEdges, edgeId)
    )
  );
  const removal = removeNodes({
    nodes: currentNodes,
    edges: currentEdges,
    nodeIds: new Set(selection.nodeIds),
  });
  const remainingNodes = removal.nodes;
  const remainingEdges =
    selectedFanOut.size === 0
      ? removal.edges
      : removal.edges.filter((edge) => !selectedFanOut.has(edge.id));

  // Selecting only the Lifecycle Node and pressing delete removes nothing, and
  // an undo step for a change that did not happen is worse than no undo step.
  if (
    remainingNodes === currentNodes &&
    remainingEdges.length === currentEdges.length
  ) {
    return;
  }

  pushHistory(get, set);
  set(nodesStateAtom, remainingNodes);
  set(edgesStateAtom, remainingEdges);
  set(activeSelectionAtom, EMPTY_SELECTION);

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
  set(activeSelectionAtom, EMPTY_SELECTION);

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
  keepSelectionInDraft(get, set);

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
  keepSelectionInDraft(get, set);

  requestGraphSave(get, set, { immediate: true });
});

export const canUndoAtom = atom((get) => get(historyAtom).length > 0);
export const canRedoAtom = atom((get) => get(futureAtom).length > 0);
