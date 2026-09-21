import type { EdgeChange, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import {
  cloneSelection,
  extractCopyableSelection,
  nodeIdsForContextCopy,
  offsetToOrigin,
  pasteOffsetClearOfCanvas,
  PASTE_OFFSET,
  type CopiedSelection,
} from "#src/lib/copy-selection";
import { repairNodeIntegrations } from "#src/lib/node-integration";
import { insertionRowPlan } from "#src/lib/workflow-node-placement";
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
  repairCanvasGroups,
  storedEdgeIdsForPaintedEdge,
} from "#src/lib/node-group";
import { getClientLogger } from "#src/lib/logger";
import {
  canonicalizeNodeEnabled,
  persistedNodeEnabled,
} from "@wfgraph/shared/graph/node-enabled";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { storedCanvasConnection } from "#src/lib/group-scope-canvas";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { generateId } from "@wfgraph/shared/utils/id";
import {
  expandConnection,
  connectionAdditionsRefusal,
  type RequestedConnection,
  type ConnectionAddition,
} from "#src/components/workflow/connection-validation";
import { omit } from "es-toolkit/object";
import { groupPortKey } from "@wfgraph/shared/graph/group-port-key";
import { normalizeSourceHandleForConnection } from "#src/components/workflow/connection-handle";
import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";
import {
  canvasEdgesAtom as paintedEdgesAtom,
  canvasNodesAtom as paintedNodesAtom,
} from "#src/lib/workflow-graph-presentation-store";
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
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";

export {
  executionOverlayGraphAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
export {
  connectNodesAtom,
  deleteCanvasSelectionAtom,
  deleteEdgeAtom,
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
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
  projectedRunStatusAtom,
  projectRunProgressAtom,
  runNodeEvidenceStatusesAtom,
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

    // Deletion is a complete operation, never a partial React Flow change batch.
    const filteredChanges = changes.filter(
      (change) => change.type !== "select" && change.type !== "remove"
    );
    const isDragFrame = filteredChanges.some(
      (change) => change.type === "position" && change.dragging === true
    );
    const isDragSettled = filteredChanges.some(
      (change) => change.type === "position" && change.dragging === false
    );

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
      set(
        nodesStateAtom,
        applyNodeChanges<WorkflowNode>(filteredChanges, currentNodes)
      );
    }

    // The config panel focuses a new node only while it is the one selection.
    const newlyCreatedId = get(newlyCreatedNodeIdAtom);
    if (newlyCreatedId && get(selectedNodeAtom) !== newlyCreatedId) {
      set(newlyCreatedNodeIdAtom, null);
    }

    if (isDragSettled) {
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

    // Deletion goes through the complete graph operation instead.
    const graphChanges = changes.filter(
      (change) => change.type !== "select" && change.type !== "remove"
    );
    if (graphChanges.length === 0) {
      return;
    }
    set(edgesStateAtom, applyEdgeChanges(graphChanges, get(edgesStateAtom)));
  }
);

/**
 * What inserting steps did: stored them, or refused with a sentence a person
 * reads, in which case the graph, its history and its save are unchanged.
 */
export type InsertOutcome = { inserted: true } | { refusal: string };

/**
 * The id of the Group the active address has entered, when the graph still
 * holds that frame. Null on the overview.
 */
function focusedGroupId(get: Getter): string | null {
  const { scope } = get(activeWorkspaceAddressAtom);
  if (scope.kind !== "group") {
    return null;
  }
  return get(nodesStateAtom).some(
    (node) => node.id === scope.groupId && isGroupNode(node)
  )
    ? scope.groupId
    : null;
}

/**
 * `subgraph` as the active address inserts it. On a focused Group each node
 * whose frame was not inserted with it becomes a member of that Group. Its
 * position stays in the focused canvas's coordinate space.
 */
function subgraphForActiveScope(
  get: Getter,
  subgraph: CopiedSelection
): CopiedSelection {
  const nodes = subgraph.nodes.map((node) => omit(node, ["selected"]));
  const edges = subgraph.edges.map((edge) => omit(edge, ["selected"]));
  const groupId = focusedGroupId(get);
  if (groupId === null) {
    return { nodes, edges };
  }
  const insertedIds = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map((node) =>
      node.parentId !== undefined && insertedIds.has(node.parentId)
        ? node
        : { ...node, parentId: groupId }
    ),
    edges,
  };
}

/**
 * One connection an insert stores, as the canvas asked for it. A connection a
 * stub stands for arrives translated by `storedCanvasConnection`, which
 * `throughBoundaryStub` records.
 */
type PlannedConnection = {
  request: RequestedConnection & { id: string };
  throughBoundaryStub: boolean;
};

/** Expand the replacement first, then validate its complete graph atomically. */
function planInsertedConnections(input: {
  edges: WorkflowEdge[];
  nodes: WorkflowNode[];
  connections: readonly PlannedConnection[];
  catalog: ExtensionCatalog;
}): { edges: WorkflowEdge[] } | { refusal: string } {
  let edges = input.edges;
  for (const { request, throughBoundaryStub } of input.connections) {
    const { id, ...requested } = request;
    const plan = expandConnection({
      connection: requested,
      throughBoundaryStub,
      nodes: input.nodes,
      storeEdges: edges,
      catalog: input.catalog,
    });
    if ("refusal" in plan) {
      return plan;
    }
    edges = [
      ...edges,
      ...plan.additions.map((addition, index) => ({
        id: index === 0 ? id : generateId(),
        ...addition,
      })),
    ];
  }
  const refusal = connectionAdditionsRefusal({
    nodes: input.nodes,
    edges: input.edges,
    additions: edges.slice(input.edges.length),
  });
  return refusal === null ? { edges } : { refusal };
}

/**
 * Append a subgraph as one undo step: deselect what is on the canvas, select
 * the inserted nodes, and save. Paste, duplicate, addNode, Add step after and
 * Insert step all go through here so the history / selection / save bookkeeping
 * cannot drift. On a focused Group the inserted steps join that Group.
 *
 * A replacement names concrete additions and the stored edges it removes.
 * Gestures resolve their painted ports against the graph containing the new
 * nodes. Both paths validate the complete result before committing anything.
 */
function insertClonedSubgraph(
  get: Getter,
  set: Setter,
  subgraph: CopiedSelection,
  options?:
    | StoredEdgeReplacement
    | {
        connections: readonly PlannedConnection[];
        catalog: ExtensionCatalog;
      },
  movedNodes?: ReadonlyMap<string, { x: number; y: number }>
): InsertOutcome {
  const { nodes, edges } = subgraphForActiveScope(get, subgraph);
  const currentNodes = get(nodesStateAtom);
  const positionedNodes = movedNodes
    ? mapOrSame(currentNodes, (node) => {
        const position = movedNodes.get(node.id);
        return position ? { ...node, position } : node;
      })
    : currentNodes;

  // Sorted like the other two writers: a cloned frame appended after the
  // members already on the canvas costs `displayNodesAtom` its fast path.
  const nextNodes = orderGroupParentsFirst([...positionedNodes, ...nodes]);
  const removed = new Set(
    options && "removeEdgeIds" in options ? options.removeEdgeIds : []
  );
  const insertedEdges = [
    ...get(edgesStateAtom).filter((edge) => !removed.has(edge.id)),
    ...edges,
  ];
  let nextEdges = insertedEdges;
  if (options && "additions" in options) {
    const refusal = connectionAdditionsRefusal({
      nodes: nextNodes,
      edges: insertedEdges,
      additions: options.additions,
    });
    if (refusal !== null) return { refusal };
    nextEdges = [
      ...insertedEdges,
      ...options.additions.map((addition) => ({
        ...addition,
        id: generateId(),
      })),
    ];
  } else if (options) {
    const planned = planInsertedConnections({
      edges: insertedEdges,
      nodes: nextNodes,
      connections: options.connections,
      catalog: options.catalog,
    });
    if ("refusal" in planned) {
      return planned;
    }
    nextEdges = planned.edges;
  }
  const structureRefusal = groupStructureRefusalReason({
    nodes: nextNodes,
    edges: nextEdges,
  });
  if (structureRefusal !== null) return { refusal: structureRefusal };

  pushHistory(get, set);
  set(nodesStateAtom, nextNodes);
  set(edgesStateAtom, nextEdges);
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
  return { inserted: true };
}

/**
 * The copyable selection, or the context-clicked node. On the overview a
 * selected member or frame brings its whole Group. On a focused Group the
 * selected members are copied alone, so a paste there adds those steps.
 */
function snapshotCopyable(
  get: Getter,
  clickedNodeId?: string
): CopiedSelection | null {
  const nodes = get(nodesStateAtom);
  const selectedIds = new Set(get(activeSelectionAtom).nodeIds);
  const wholeGroups = focusedGroupId(get) === null;
  return extractCopyableSelection({
    nodes,
    edges: get(edgesStateAtom),
    nodeIds: clickedNodeId
      ? nodeIdsForContextCopy(nodes, clickedNodeId, selectedIds, {
          wholeGroups,
        })
      : selectedIds,
    wholeGroups,
  });
}

/**
 * Add one step, selected, as one undo step. On a focused Group it becomes a
 * member of that Group. Null when the draft is not editable.
 */
export const addNodeAtom = atom(
  null,
  (get, set, node: WorkflowNode): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    return insertClonedSubgraph(get, set, { nodes: [node], edges: [] });
  }
);

/**
 * Add one step and the connection a drag into empty canvas asked for, as one
 * undo step. The connection is planned against the graph holding the new step,
 * with the same rules `connectNodesAtom` applies, so a step added after a
 * member of a focused Group joins that Group and connects the way it would
 * between two existing members. A refused connection adds neither. Null when
 * the draft is not editable.
 */
export const addConnectedNodeAtom = atom(
  null,
  (
    get,
    set,
    input: {
      node: WorkflowNode;
      connection: RequestedConnection & { id: string };
      throughBoundaryStub: boolean;
      catalog: ExtensionCatalog;
    }
  ): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    return insertClonedSubgraph(
      get,
      set,
      { nodes: [input.node], edges: [] },
      {
        connections: [
          {
            request: input.connection,
            throughBoundaryStub: input.throughBoundaryStub,
          },
        ],
        catalog: input.catalog,
      }
    );
  }
);

/**
 * `request` as the store connects it: a painted end that stands for a boundary
 * stub becomes the outside port it names. Empty when the painted connection
 * stores nothing, such as one onto a "Path ends" stub.
 */
function plannedConnection(
  get: Getter,
  request: RequestedConnection & { id: string }
): PlannedConnection[] {
  const { id, ...painted } = request;
  const stored = storedCanvasConnection(painted, get(paintedNodesAtom));
  return "refusal" in stored
    ? []
    : [
        {
          request: { ...stored.connection, id },
          throughBoundaryStub: stored.throughBoundaryStub,
        },
      ];
}

type StoredEdgeReplacement = {
  removeEdgeIds: readonly string[];
  additions: ConnectionAddition[];
};

/** Exact stored ports are replaced directly; they never re-enter gesture expansion. */
function replacementPlan(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeIds: readonly string[];
  node: WorkflowNode;
  catalog: ExtensionCatalog;
}): StoredEdgeReplacement {
  const removed = new Set(input.edgeIds);
  const edges = input.edges.filter((edge) => removed.has(edge.id));
  const nodeId = input.node.id;
  const sources = Map.groupBy(edges, (edge) =>
    groupPortKey({ nodeId: edge.source, handle: edge.sourceHandle ?? null })
  );
  const targets = Map.groupBy(edges, (edge) =>
    groupPortKey({ nodeId: edge.target, handle: edge.targetHandle ?? null })
  );
  const incoming = [...sources.values()].flatMap(([edge]) =>
    edge
      ? [
          {
            id: edge.id,
            source: edge.source,
            sourceHandle: edge.sourceHandle ?? null,
            target: nodeId,
          },
        ]
      : []
  );
  // Only the new node needs an outlet choice; existing ports remain exact.
  const sourceHandle = normalizeSourceHandleForConnection({
    nodes: [...input.nodes, input.node],
    edges: [
      ...input.edges.filter((edge) => !removed.has(edge.id)),
      ...incoming,
    ],
    sourceNodeId: nodeId,
    sourceHandle: null,
    catalog: input.catalog,
  });
  return {
    removeEdgeIds: edges.map((edge) => edge.id),
    additions: [
      ...incoming.map(({ id: _id, ...addition }) => addition),
      ...[...targets.values()].flatMap(([edge]) =>
        edge
          ? [
              {
                source: nodeId,
                sourceHandle,
                target: edge.target,
                targetHandle: edge.targetHandle ?? null,
              },
            ]
          : []
      ),
    ],
  };
}

/**
 * Insert one step after an outlet, replacing its outgoing connections with
 * source → new step → previous targets. An empty outlet simply gains one edge.
 * The whole edit is one undo step; a refusal stores nothing.
 */
export const addStepAfterAtom = atom(
  null,
  (
    get,
    set,
    input: {
      node: WorkflowNode;
      source: { nodeId: string; handle: string | null };
      catalog: ExtensionCatalog;
    }
  ): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    const connections = plannedConnection(get, {
      id: generateId(),
      source: input.source.nodeId,
      target: input.node.id,
      sourceHandle: input.source.handle,
      targetHandle: null,
    });
    if (connections.length === 0) {
      return { refusal: "Add a step after a step inside the Group." };
    }
    const outgoing = get(paintedEdgesAtom).filter(
      (edge) =>
        edge.source === input.source.nodeId &&
        (edge.sourceHandle ?? null) === input.source.handle &&
        edge.data?.insertable !== false
    );
    const removeEdgeIds = outgoing.flatMap((edge) =>
      storedEdgeIdsForPaintedEdge({
        nodes: get(nodesStateAtom),
        edges: get(edgesStateAtom),
        edgeId: edge.id,
        scope: get(activeWorkspaceAddressAtom).scope,
      })
    );
    return insertClonedSubgraph(
      get,
      set,
      { nodes: [input.node], edges: [] },
      removeEdgeIds.length > 0
        ? replacementPlan({
            nodes: get(nodesStateAtom),
            edges: get(edgesStateAtom),
            edgeIds: removeEdgeIds,
            node: input.node,
            catalog: input.catalog,
          })
        : { connections, catalog: input.catalog }
    );
  }
);

/**
 * Put one step inside the connection `edgeId`, as one undo step: the connection
 * is replaced by one from its source to the new step and one from the new step
 * to its target, each keeping the handle the replaced connection used. On a
 * collapsed Group card, or a Group's "Continues to" stub, the stored edges the
 * painted connection stands for are the ones replaced. Null when the draft is
 * not editable.
 */
export const insertStepOnEdgeAtom = atom(
  null,
  (
    get,
    set,
    input: { node: WorkflowNode; edgeId: string; catalog: ExtensionCatalog }
  ): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    const painted = get(paintedEdgesAtom).find(
      (edge) => edge.id === input.edgeId
    );
    const removeEdgeIds = painted
      ? storedEdgeIdsForPaintedEdge({
          nodes: get(nodesStateAtom),
          edges: get(edgesStateAtom),
          edgeId: input.edgeId,
          scope: get(activeWorkspaceAddressAtom).scope,
        })
      : [];
    if (!painted || removeEdgeIds.length === 0) {
      return { refusal: "Insert a step into a connection the draft holds." };
    }
    const rowPlan = insertionRowPlan(
      get(paintedNodesAtom),
      get(paintedEdgesAtom),
      painted.source,
      painted.target
    );
    const node = rowPlan
      ? { ...input.node, position: rowPlan.position }
      : input.node;
    return insertClonedSubgraph(
      get,
      set,
      { nodes: [node], edges: [] },
      replacementPlan({
        nodes: get(nodesStateAtom),
        edges: get(edgesStateAtom),
        edgeIds: removeEdgeIds,
        node,
        catalog: input.catalog,
      }),
      rowPlan?.movedNodes
    );
  }
);

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
 * each paste steps down-right from the original so repeats do not stack. The
 * pasted nodes then move clear of every card on the overview.
 */
export const pasteCopiedSelectionAtom = atom(
  null,
  (get, set, origin?: { x: number; y: number }): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    const clipboard = get(copiedSelectionAtom);
    if (!clipboard) {
      return null;
    }

    const nextCount = clipboard.pasteCount + 1;
    const offset = pasteOffsetClearOfCanvas({
      selection: clipboard.selection,
      offset: origin
        ? offsetToOrigin(clipboard.selection.nodes, origin)
        : { x: PASTE_OFFSET * nextCount, y: PASTE_OFFSET * nextCount },
      canvasNodes: get(paintedNodesAtom),
    });

    const outcome = insertClonedSubgraph(
      get,
      set,
      cloneSelection(clipboard.selection, { offset })
    );
    if ("inserted" in outcome) {
      set(copiedSelectionAtom, { ...clipboard, pasteCount: nextCount });
    }
    return outcome;
  }
);

/**
 * Clone the current (or context-clicked) selection in one undo step without
 * writing the clipboard, so a later paste still inserts whatever was copied.
 */
export const duplicateSelectionAtom = atom(
  null,
  (get, set, clickedNodeId?: string): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    const selection = snapshotCopyable(get, clickedNodeId);
    if (!selection) {
      return null;
    }

    return insertClonedSubgraph(
      get,
      set,
      cloneSelection(selection, {
        offset: pasteOffsetClearOfCanvas({
          selection,
          offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
          canvasNodes: get(paintedNodesAtom),
        }),
      })
    );
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

/** Apply Tidy as one undo step. A focused Tidy writes only member positions. */
export const applyNodeLayoutAtom = atom(
  null,
  (get, set, nodes: WorkflowNode[]) => {
    if (!draftEditable(get)) {
      return;
    }

    const groupId = focusedGroupId(get);
    const positions = new Map(nodes.map((node) => [node.id, node.position]));
    const current = get(nodesStateAtom);
    const next =
      groupId === null
        ? nodes
        : mapOrSame(current, (node) => {
            const position = positions.get(node.id);
            return node.parentId === groupId &&
              position &&
              (position.x !== node.position.x || position.y !== node.position.y)
              ? { ...node, position }
              : node;
          });
    if (next === current) return;
    pushHistory(get, set);
    set(nodesStateAtom, next);
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
