import type { EdgeChange, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import { union } from "es-toolkit/array";
import { isEqual } from "es-toolkit/predicate";
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
  isGeneratingAtom,
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { placeNewWorkflowNodes } from "@wfgraph/shared/graph/workflow-placement";
import { repairCanvasGroups } from "#src/lib/node-group";
import { getClientLogger } from "#src/lib/logger";
import {
  canonicalizeNodeEnabled,
  persistedNodeEnabled,
} from "@wfgraph/shared/graph/node-enabled";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import {
  absolutePosition,
  canvasPlacementNodes,
  groupRegionAt,
  joinGroup,
  sharedGroupOf,
  storedEdgeIdsForPaintedEdge,
  storedPosition,
} from "#src/lib/group-canvas";
import { collapsedGroupIdsAtom } from "#src/lib/collapsed-groups";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { generateId } from "@wfgraph/shared/utils/id";
import { type MoveStepDirection, moveStepInSequence } from "#src/lib/move-step";
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
  workflowDragOriginAtom,
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
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { requestRevealPlacementAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";

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
  canvasPlacementNodesAtom,
  clearNodeStatusesAtom,
  displayNodesAtom,
  isExecutingAtom,
  isExecutionOverlayActiveAtom,
  isLiveRunCanvasAtom,
  presentedGraphAtom,
  presentedGraphStructureAtom,
  projectedRunStatusAtom,
  projectRunLogsAtom,
  projectRunProgressAtom,
  runNodeEvidenceStatusesAtom,
  runPathAtom,
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
 * Reconcile every node's connection references with the list as it stands now.
 *
 * Called from the handlers that already know the connection list changed, which
 * is the only moment a stored id can newly have gone stale while the editor is
 * open. `chosen` is a Connection the person just created for the steps that
 * need its type. `repairNodeIntegrations` returns the same array when nothing
 * needed fixing, so the common case writes nothing and queues no save.
 */
export const repairIntegrationsAtom = atom(
  null,
  (
    get,
    set,
    input: {
      integrations: readonly { id: string; type: string }[];
      catalog: ExtensionCatalog;
      chosen?: { id: string; type: string } | undefined;
    }
  ) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);
    const repaired = repairNodeIntegrations(
      input.catalog,
      currentNodes,
      input.integrations,
      input.chosen
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

function isSettledPosition(change: NodeChange<WorkflowNode>): boolean {
  return change.type === "position" && change.dragging === false;
}

/**
 * Return the nodes a drag moved to where they were before it, and drop its
 * undo entry. For a drag the editing lock interrupted: the draft takes no
 * write while something else owns the canvas, so the move is not saved.
 */
function cancelNodeDrag(get: Getter, set: Setter) {
  const origin = get(workflowDragOriginAtom);
  if (!origin) {
    return;
  }
  set(workflowDragOriginAtom, null);
  const positions = new Map(
    origin.nodes.map((node) => [node.id, node.position])
  );
  set(
    nodesStateAtom,
    mapOrSame(get(nodesStateAtom), (node) => {
      const position = positions.get(node.id);
      return position && position !== node.position
        ? { ...omit(node, ["dragging"]), position }
        : node;
    })
  );
  const history = get(historyAtom);
  if (history.at(-1) === origin) {
    set(historyAtom, history.slice(0, -1));
  }
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

    // The canvas is locked while the agent rewrites the graph, too.
    if (!draftEditable(get) || get(isGeneratingAtom)) {
      if (changes.some(isSettledPosition)) {
        cancelNodeDrag(get, set);
      }
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
    const isDragSettled = filteredChanges.some(isSettledPosition);
    const dragActive = get(workflowDragActiveAtom);

    if (isDragFrame && !dragActive) {
      // A drag arrives as a stream of frames. Only the first still has the
      // pre-drag positions worth snapshotting.
      pushHistory(get, set);
      set(workflowDragOriginAtom, get(historyAtom).at(-1) ?? null);
    }

    if (isDragSettled && !isDragFrame && !dragActive) {
      // An arrow-key nudge moves the selection in one settled change with no
      // drag frames before it, so it is recorded as one undo step here.
      pushHistory(get, set);
    }

    if (isDragSettled) {
      set(workflowDragOriginAtom, null);
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
 * The Group a step inserted at the canvas point `at` joins: the Group drawn in
 * place whose region holds the point, or null.
 */
function groupAt(get: Getter, at: { x: number; y: number }): string | null {
  return groupRegionAt({
    point: at,
    nodes: get(nodesStateAtom),
    collapsedGroupIds: get(collapsedGroupIdsAtom),
  });
}

/** The one Group every selected step is a member of, or null. */
function selectedStepsGroup(get: Getter): string | null {
  return sharedGroupOf(get(activeSelectionAtom).nodeIds, get(nodesStateAtom));
}

/** One connection an insert stores, as the canvas asked for it. */
type PlannedConnection = {
  request: RequestedConnection & { id: string };
};

/** Expand the replacement first, then validate its complete graph atomically. */
function planInsertedConnections(input: {
  edges: WorkflowEdge[];
  nodes: WorkflowNode[];
  connections: readonly PlannedConnection[];
  catalog: ExtensionCatalog;
}): { edges: WorkflowEdge[] } | { refusal: string } {
  let edges = input.edges;
  for (const { request } of input.connections) {
    const { id, ...requested } = request;
    const plan = expandConnection({
      connection: requested,
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
 * cannot drift. The inserted steps whose frame did not come with them join the
 * Group `joinsGroup` names, at positions turned local to its frame.
 *
 * A replacement names concrete additions and the stored edges it removes.
 * Gestures resolve their painted ports against the graph containing the new
 * nodes. Both paths validate the complete result before committing anything.
 */
function insertClonedSubgraph(
  get: Getter,
  set: Setter,
  subgraph: CopiedSelection & { joinsGroup?: string | null | undefined },
  options?:
    | StoredEdgeReplacement
    | {
        connections: readonly PlannedConnection[];
        catalog: ExtensionCatalog;
      },
  movedNodes?: ReadonlyMap<string, { x: number; y: number }>
): InsertOutcome {
  const currentNodes = get(nodesStateAtom);
  const nodes = joinGroup({
    inserted: subgraph.nodes.map((node) => omit(node, ["selected"])),
    groupId: subgraph.joinsGroup ?? null,
    nodes: currentNodes,
  });
  const edges = subgraph.edges.map((edge) => omit(edge, ["selected"]));
  // Placement answers canvas points, which a member stores local to its frame.
  const positionedNodes = movedNodes
    ? mapOrSame(currentNodes, (node) => {
        const position = movedNodes.get(node.id);
        return position
          ? {
              ...node,
              position: storedPosition(node.id, position, currentNodes),
            }
          : node;
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

  // The camera shows the new steps once, moving the least it must to bring
  // them clear of the agent's prompt line and the controls floating over
  // the canvas, and not at all when they are already in view. A step
  // duplicated below the graph, or dropped at the bottom of the canvas,
  // otherwise lands under the prompt line.
  set(requestRevealPlacementAtom, {
    addressId: workspaceAddressId(get(activeWorkspaceAddressAtom)),
    nodeIds: [...topLevelIds],
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
 * The copyable selection, or the context-clicked node. A selected Group frame
 * brings its members, and a selected member is copied alone, at its canvas
 * position, so a paste of it stands outside any Group unless it joins one.
 */
function snapshotCopyable(
  get: Getter,
  clickedNodeId?: string
): CopiedSelection | null {
  const stored = get(nodesStateAtom);
  const selectedIds = new Set(get(activeSelectionAtom).nodeIds);
  const named = clickedNodeId
    ? nodeIdsForContextCopy(stored, clickedNodeId, selectedIds, {
        wholeGroups: false,
      })
    : selectedIds;
  const nodeIds = new Set([
    ...named,
    ...stored
      .filter((node) => node.parentId !== undefined && named.has(node.parentId))
      .map((node) => node.id),
  ]);
  // A member copied without its frame takes its canvas position.
  const nodes = stored.map((node) =>
    node.parentId !== undefined && !nodeIds.has(node.parentId)
      ? { ...node, position: absolutePosition(node, stored) }
      : node
  );
  return extractCopyableSelection({
    nodes,
    edges: get(edgesStateAtom),
    nodeIds,
    wholeGroups: false,
  });
}

/**
 * Add one step at its canvas position, selected, as one undo step. A step
 * placed inside a Group's region joins that Group. Null when the draft is not
 * editable.
 */
export const addNodeAtom = atom(
  null,
  (get, set, node: WorkflowNode): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    return insertClonedSubgraph(get, set, {
      nodes: [node],
      edges: [],
      joinsGroup: groupAt(get, node.position),
    });
  }
);

/**
 * Add one step and the connection a drag into empty canvas asked for, as one
 * undo step. The connection is planned against the graph holding the new step,
 * with the same rules `connectNodesAtom` applies. The step joins the Group
 * whose region it is dropped in. A refused connection adds neither. Null when
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
      catalog: ExtensionCatalog;
    }
  ): InsertOutcome | null => {
    if (!draftEditable(get)) {
      return null;
    }

    return insertClonedSubgraph(
      get,
      set,
      {
        nodes: [input.node],
        edges: [],
        joinsGroup: groupAt(get, input.node.position),
      },
      {
        connections: [{ request: input.connection }],
        catalog: input.catalog,
      }
    );
  }
);

/** `request` as the store connects it. */
function plannedConnection(
  request: RequestedConnection & { id: string }
): PlannedConnection[] {
  return [{ request }];
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

    const connections = plannedConnection({
      id: generateId(),
      source: input.source.nodeId,
      target: input.node.id,
      sourceHandle: input.source.handle,
      targetHandle: null,
    });
    const outgoing = get(paintedEdgesAtom).filter(
      (edge) =>
        edge.source === input.source.nodeId &&
        (edge.sourceHandle ?? null) === input.source.handle
    );
    const removeEdgeIds = outgoing.flatMap((edge) =>
      storedEdgeIdsForPaintedEdge({
        nodes: get(nodesStateAtom),
        edges: get(edgesStateAtom),
        edgeId: edge.id,
        collapsedGroupIds: get(collapsedGroupIdsAtom),
      })
    );
    // A step put between an outlet and the one step it leads to takes that
    // step's place, and the step and everything below it move down a row,
    // as a step put inside a connection does, so the new card is drawn
    // between the two it connects.
    const only = outgoing.length === 1 ? outgoing[0] : undefined;
    const rowPlan = only
      ? insertionRowPlan(
          canvasPlacementNodes(get(paintedNodesAtom)),
          get(paintedEdgesAtom),
          only.source,
          only.target
        )
      : null;
    const node = rowPlan
      ? { ...input.node, position: rowPlan.position }
      : input.node;
    // A step added after a member joins that member's Group.
    return insertClonedSubgraph(
      get,
      set,
      {
        nodes: [node],
        edges: [],
        joinsGroup: sharedGroupOf([input.source.nodeId], get(nodesStateAtom)),
      },
      removeEdgeIds.length > 0
        ? replacementPlan({
            nodes: get(nodesStateAtom),
            edges: get(edgesStateAtom),
            edgeIds: removeEdgeIds,
            node,
            catalog: input.catalog,
          })
        : { connections, catalog: input.catalog },
      rowPlan?.movedNodes
    );
  }
);

/**
 * Put one step inside the connection `edgeId`, as one undo step: the connection
 * is replaced by one from its source to the new step and one from the new step
 * to its target, each keeping the handle the replaced connection used. On a
 * collapsed Group card the stored edges the painted connection stands for are
 * the ones replaced. Null when the draft is not editable.
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
          collapsedGroupIds: get(collapsedGroupIdsAtom),
        })
      : [];
    if (!painted || removeEdgeIds.length === 0) {
      return { refusal: "Insert a step into a connection the draft holds." };
    }
    const rowPlan = insertionRowPlan(
      canvasPlacementNodes(get(paintedNodesAtom)),
      get(paintedEdgesAtom),
      painted.source,
      painted.target
    );
    const node = rowPlan
      ? { ...input.node, position: rowPlan.position }
      : input.node;
    // A step put inside a connection leaving a member joins that member's
    // Group, as a step added after the member does, so the Group keeps the
    // exit it had.
    return insertClonedSubgraph(
      get,
      set,
      {
        nodes: [node],
        edges: [],
        joinsGroup: sharedGroupOf([painted.source], get(nodesStateAtom)),
      },
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

/**
 * Swap a step with the step before or after it in its sequence, as one undo
 * step. The two steps trade their connections and positions, and the
 * selection stays where it was. Answers the refusal `moveStepInSequence`
 * gives for a shape that cannot swap, and null when the draft is not
 * editable.
 */
export const moveStepAtom = atom(
  null,
  (
    get,
    set,
    input: { nodeId: string; direction: MoveStepDirection }
  ): { moved: true } | { refusal: string } | null => {
    if (!draftEditable(get)) {
      return null;
    }
    const outcome = moveStepInSequence({
      nodes: get(nodesStateAtom),
      edges: get(edgesStateAtom),
      nodeId: input.nodeId,
      direction: input.direction,
    });
    if ("refusal" in outcome) {
      return outcome;
    }
    pushHistory(get, set);
    set(nodesStateAtom, outcome.nodes);
    set(edgesStateAtom, outcome.edges);
    requestGraphSave(get, set, { immediate: true });
    return { moved: true };
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
      canvasNodes: canvasPlacementNodes(get(paintedNodesAtom)),
    });

    // A paste at a point inside a Group's region joins that Group. Any other
    // paste joins the Group every selected step is a member of, if one is.
    const outcome = insertClonedSubgraph(get, set, {
      ...cloneSelection(clipboard.selection, { offset }),
      joinsGroup: origin ? groupAt(get, origin) : selectedStepsGroup(get),
    });
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

    // Duplicated members stay in the Group the selected steps share.
    return insertClonedSubgraph(get, set, {
      ...cloneSelection(selection, {
        offset: pasteOffsetClearOfCanvas({
          selection,
          offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
          canvasNodes: canvasPlacementNodes(get(paintedNodesAtom)),
        }),
      }),
      joinsGroup: clickedNodeId
        ? sharedGroupOf([clickedNodeId], get(nodesStateAtom))
        : selectedStepsGroup(get),
    });
  }
);

/**
 * Put the build agent's version of the workflow on the canvas.
 *
 * The caller marks the first graph in a turn as its undo boundary. The agent
 * chooses no coordinates, so every graph update gets a complete layout pass.
 * The turn is the Draft's only writer while it runs, so its graph lands on the
 * Draft whichever workspace is presenting: a graph refused because the user
 * opened Runs mid-turn would be the turn's work lost.
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
      input.turnId !== get(activeAgentTurnIdAtom)
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

    // The turn's document never learns where the editor places a step, so
    // every later write of the turn sends an added step at the origin again.
    // A step already on the canvas therefore keeps the canvas's position.
    const arriving = repair.nodes.map((node) => {
      const existing = existingById.get(node.id);
      return existing !== undefined &&
        node.position.x === 0 &&
        node.position.y === 0
        ? { ...node, position: existing.position }
        : node;
    });

    // Only a step the agent added is placed, beside its neighbours; a step on
    // the canvas keeps the position the person gave it. A step the agent
    // added arrives at the origin, while one a revert brought back carries
    // the position it had.
    const laidOut = placeNewWorkflowNodes({
      nodes: arriving,
      edges: input.edges,
      catalog: input.catalog,
      unplacedIds: new Set(
        arriving
          .filter(
            (node) =>
              !existingById.has(node.id) &&
              node.position.x === 0 &&
              node.position.y === 0
          )
          .map((node) => node.id)
      ),
    });

    // A placed node is rebuilt, so identity is restored here rather than
    // assumed. `displayNodesAtom` keeps a paint cache
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
    // a selected frame. Runs and Changes select in, and fit, their own graphs.
    if (get(workflowWorkspaceViewAtom) === "draft") {
      keepSelectionInDraft(get, set);
      set(workflowGraphUpdateAtom, {
        workflowId: input.workflowId,
        revision: (get(workflowGraphUpdateAtom)?.revision ?? 0) + 1,
      });
    }
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

/** Apply Tidy as one undo step. */
export const applyNodeLayoutAtom = atom(
  null,
  (get, set, nodes: WorkflowNode[]) => {
    if (!draftEditable(get)) {
      return;
    }

    if (nodes === get(nodesStateAtom)) return;
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
  /** False for a write that is not an edit, which leaves no undo step. */
  recordHistory?: boolean | undefined;
};

/**
 * Names the fields an edit changes on one node, such as `step_4:label` or
 * `step_4:config.subject`, so consecutive keystrokes in one field share an
 * undo step and an edit of another field starts a new one.
 */
function fieldEditGroup(
  id: string,
  node: WorkflowNode | undefined,
  data: NodeDataUpdate["data"]
): string {
  const fields = Object.keys(data).flatMap((key) => {
    if (key === "config") {
      const next = data.config ?? {};
      const previous = node?.data.config ?? {};
      return union(Object.keys(next), Object.keys(previous))
        .filter((configKey) => !isEqual(next[configKey], previous[configKey]))
        .map((configKey) => `config.${configKey}`);
    }
    const previous = node ? Reflect.get(node.data, key) : undefined;
    return isEqual(Reflect.get(data, key), previous) ? [] : [key];
  });
  return `${id}:${fields.toSorted().join(",")}`;
}

/**
 * Write an edit into one node's data: label, description, config. Run status
 * does not travel through here -- it is never part of a node's own data, so
 * it has its own writer, `setNodeStatusesAtom`.
 */
export const updateNodeDataAtom = atom(
  null,
  (get, set, { id, data, recordHistory = true }: NodeDataUpdate) => {
    if (!draftEditable(get)) {
      return;
    }

    const currentNodes = get(nodesStateAtom);
    const oldNode = currentNodes.find((node) => node.id === id);
    if (recordHistory) {
      pushHistory(get, set, { group: fieldEditGroup(id, oldNode, data) });
    }

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

/**
 * Ends the redo branch of `workflowId` when it is the open workflow. A publish
 * calls this, so an edit undone before the publish cannot come back after it
 * and leave the draft just published changed again. The undo history stays:
 * undoing past a publish is an ordinary edit of the draft.
 */
export const endRedoBranchAtom = atom(null, (get, set, workflowId: string) => {
  if (get(currentWorkflowIdAtom) === workflowId) {
    set(futureAtom, []);
  }
});

export const canUndoAtom = atom((get) => get(historyAtom).length > 0);
export const canRedoAtom = atom((get) => get(futureAtom).length > 0);
