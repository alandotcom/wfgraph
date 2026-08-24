import {
  ConnectionMode,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnConnectEnd,
  type OnConnectStartParams,
  useInternalNode,
  useReactFlow,
  type Connection as XYFlowConnection,
  type Edge as XYFlowEdge,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef, useState } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { Canvas } from "#src/components/flow-elements/canvas";
import { Connection } from "#src/components/flow-elements/connection";
import { Controls } from "#src/components/flow-elements/controls";
import "@xyflow/react/dist/style.css";

import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Edge } from "#src/components/flow-elements/edge";
import { Panel } from "#src/components/flow-elements/panel";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  useAfterDelay,
  useAfterPaint,
  useBeforePaint,
  useDomEvent,
} from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { isTextEntry } from "#src/lib/is-text-entry";
import {
  addNodeAtom,
  connectNodesAtom,
  displayEdgesAtom,
  displayNodesAtom,
  edgesAtom,
  canvasEditingLockedAtom,
  isExecutionOverlayActiveAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  redoAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  snapshotHistoryAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import {
  activeComparisonAtom,
  moveComparisonNodesAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { isGeneratingAtom, showMinimapAtom } from "#src/lib/workflow-ui-store";
import {
  workflowNodeAriaLabel,
  WORKFLOW_EDGE_TYPE,
} from "#src/lib/workflow-graph-types";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { refuseDeleteWithNotice } from "#src/lib/node-group";
import { normalizeSourceHandleForConnection as normalizeSourceHandle } from "./connection-handle";
import { ActionNode } from "./nodes/action-node";
import { AddNode } from "./nodes/add-node";
import { GroupNode } from "./nodes/group-node";
import { LifecycleNode } from "./nodes/lifecycle-node";
import { useCanvasCopyPaste } from "./use-canvas-copy-paste";
import { useReflowLayout } from "./use-reflow-layout";
import { useCollectWorkflowIssues } from "#src/hooks/use-workflow-issues";
import {
  type ContextMenuState,
  useContextMenuHandlers,
  WorkflowContextMenu,
} from "./workflow-context-menu";
import { WORKFLOW_NODE_HEIGHT } from "#src/lib/workflow-node-dimensions";
import {
  connectionHandleTypesMatch,
  connectionRefusalReason,
} from "./connection-validation";
import { workflowEdgeAriaLabel } from "#src/components/flow-elements/edge-label";

const edgeTypes = {
  [WORKFLOW_EDGE_TYPE]: Edge.Animated,
};

/**
 * Every edge draws with the canvas edge. React Flow merges this under each edge
 * before it resolves the component, so no edge carries a type of its own and no
 * place that builds one can leave it off. Getting that wrong is answered with
 * React Flow's built-in bezier, which is how a reload used to lose the
 * orthogonal path.
 */
const defaultEdgeOptions = { type: WORKFLOW_EDGE_TYPE };

const nodeTypes = {
  lifecycle: LifecycleNode,
  action: ActionNode,
  add: AddNode,
  group: GroupNode,
};

export function canvasInteractionState({
  editingLocked,
  comparisonActive,
  overlayActive,
}: {
  editingLocked: boolean;
  comparisonActive: boolean;
  overlayActive: boolean;
}) {
  const comparisonVisible = comparisonActive && !overlayActive;
  return {
    comparisonVisible,
    elementsSelectable: !editingLocked || comparisonVisible,
    nodesDraggable: !editingLocked || comparisonVisible,
    edgesFocusable: !comparisonVisible,
    deleteKeyCode: comparisonVisible ? null : ["Backspace", "Delete"],
  };
}

export function canvasFitViewKey({
  workflowId,
  lifecycleNode,
}: {
  workflowId: string | null;
  lifecycleNode: Pick<WorkflowNode, "id" | "position"> | null;
}): string | null {
  if (!workflowId || !lifecycleNode) {
    return null;
  }
  return `${workflowId}:${lifecycleNode.id}:${lifecycleNode.position.x}:${lifecycleNode.position.y}`;
}

export const keyboardFitViewOptions = { padding: 0.2, duration: 0 } as const;

type InternalLifecycleAnchor = {
  userNode: WorkflowNode;
  position: { x: number; y: number };
  width: number | undefined;
};

export function synchronizedLifecycleAnchor(
  lifecycleNode: WorkflowNode | null,
  internalNode: InternalLifecycleAnchor | null
): { id: string; position: { x: number; y: number }; width: number } | null {
  if (
    !lifecycleNode ||
    !internalNode?.width ||
    internalNode.userNode !== lifecycleNode
  ) {
    return null;
  }
  return {
    id: lifecycleNode.id,
    position: internalNode.position,
    width: internalNode.width,
  };
}

export function lifecycleAnchorViewport({
  canvasWidth,
  nodePosition,
  nodeWidth,
  top,
  zoom,
}: {
  canvasWidth: number;
  nodePosition: { x: number; y: number };
  nodeWidth: number;
  top: number;
  zoom: number;
}): { x: number; y: number; zoom: number } {
  return {
    x: canvasWidth / 2 - (nodePosition.x + nodeWidth / 2) * zoom,
    y: top - nodePosition.y * zoom,
    zoom,
  };
}

export function useSynchronizedLifecycleViewport({
  currentWorkflowId,
  lifecycleNode,
  internalNode,
  fittedWorkflowIdRef,
  fitGenerationRef,
  readCanvasWidth,
  getZoom,
  setViewport,
}: {
  currentWorkflowId: string | null;
  lifecycleNode: WorkflowNode | null;
  internalNode: InternalLifecycleAnchor | null;
  fittedWorkflowIdRef: { current: string | null };
  fitGenerationRef: { current: number };
  readCanvasWidth: () => number | undefined;
  getZoom: () => number;
  setViewport: (viewport: {
    x: number;
    y: number;
    zoom: number;
  }) => Promise<boolean>;
}): {
  lifecycleAnchor: ReturnType<typeof synchronizedLifecycleAnchor>;
  fitViewKey: string | null;
} {
  const lifecycleAnchor = synchronizedLifecycleAnchor(
    lifecycleNode,
    internalNode
  );
  const fitViewKey = canvasFitViewKey({
    workflowId: currentWorkflowId,
    lifecycleNode: lifecycleAnchor,
  });

  // Controlled props reach React Flow's internal store after this component
  // renders. Wait for its node identity so an incoming viewport is never
  // applied while the outgoing graph is still on screen.
  useBeforePaint(fitViewKey, () => {
    fitGenerationRef.current += 1;
    if (
      fitViewKey === null ||
      !currentWorkflowId ||
      fittedWorkflowIdRef.current !== currentWorkflowId ||
      !lifecycleAnchor
    ) {
      return;
    }

    const canvasWidth = readCanvasWidth();
    if (!canvasWidth) {
      return;
    }

    void setViewport(
      lifecycleAnchorViewport({
        canvasWidth,
        nodePosition: lifecycleAnchor.position,
        nodeWidth: lifecycleAnchor.width,
        top: 48,
        zoom: getZoom(),
      })
    );
  });

  return { lifecycleAnchor, fitViewKey };
}

export async function fitInitialWorkflowViewport({
  fitView,
  isCurrent,
  readAnchor,
  setViewport,
  reveal,
}: {
  fitView: () => Promise<boolean>;
  isCurrent: () => boolean;
  readAnchor: () => {
    canvasWidth: number;
    nodePosition: { x: number; y: number };
    nodeWidth: number;
    zoom: number;
  } | null;
  setViewport: (viewport: {
    x: number;
    y: number;
    zoom: number;
  }) => Promise<boolean>;
  reveal: () => void;
}): Promise<void> {
  try {
    if (!isCurrent()) {
      return;
    }
    await fitView();
    if (!isCurrent()) {
      return;
    }

    const anchor = readAnchor();
    if (!anchor) {
      return;
    }
    await setViewport(lifecycleAnchorViewport({ ...anchor, top: 48 }));
  } finally {
    if (isCurrent()) {
      reveal();
    }
  }
}

const accessibleNodeCache = new WeakMap<
  WorkflowNode,
  { label: string; node: WorkflowNode }
>();
const accessibleEdgeCache = new WeakMap<
  WorkflowEdge,
  { label: string; edge: WorkflowEdge }
>();
type AccessibleNodeArray = {
  catalog: ReturnType<typeof useExtensionCatalog>;
  labels: ReadonlyMap<string, string>;
  nodes: WorkflowNode[];
};
const accessibleNodeArrayCache = new WeakMap<
  WorkflowNode[],
  AccessibleNodeArray
>();
const accessibleEdgeArrayCache = new WeakMap<
  WorkflowEdge[],
  { nodeArray: AccessibleNodeArray; edges: WorkflowEdge[] }
>();

function withNodeAriaLabel(node: WorkflowNode, label: string): WorkflowNode {
  if (node.ariaLabel === label) {
    return node;
  }
  const cached = accessibleNodeCache.get(node);
  if (cached?.label === label) {
    return cached.node;
  }
  const accessible = { ...node, ariaLabel: label };
  accessibleNodeCache.set(node, { label, node: accessible });
  return accessible;
}

function withEdgeAriaLabel(edge: WorkflowEdge, label: string): WorkflowEdge {
  if (edge.ariaLabel === label) {
    return edge;
  }
  const cached = accessibleEdgeCache.get(edge);
  if (cached?.label === label) {
    return cached.edge;
  }
  const accessible = { ...edge, ariaLabel: label };
  accessibleEdgeCache.set(edge, { label, edge: accessible });
  return accessible;
}

function accessibleGraphElements(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  catalog: ReturnType<typeof useExtensionCatalog>
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const cachedNodes = accessibleNodeArrayCache.get(nodes);
  let nodeArray = cachedNodes;
  if (nodeArray?.catalog !== catalog) {
    const labels = new Map(
      nodes.map(
        (node) => [node.id, workflowNodeAriaLabel(node.data, catalog)] as const
      )
    );
    nodeArray = {
      catalog,
      labels,
      nodes: nodes.map((node) =>
        withNodeAriaLabel(node, labels.get(node.id) ?? "Unknown step")
      ),
    };
    accessibleNodeArrayCache.set(nodes, nodeArray);
  }

  const cachedEdges = accessibleEdgeArrayCache.get(edges);
  const accessibleEdges =
    cachedEdges?.nodeArray === nodeArray
      ? cachedEdges.edges
      : edges.map((edge) =>
          withEdgeAriaLabel(
            edge,
            workflowEdgeAriaLabel({
              sourceLabel: nodeArray.labels.get(edge.source) ?? "Unknown step",
              targetLabel: nodeArray.labels.get(edge.target) ?? "Unknown step",
              sourceHandleId: edge.sourceHandle,
              data: edge.data,
            })
          )
        );
  if (cachedEdges?.nodeArray !== nodeArray) {
    accessibleEdgeArrayCache.set(edges, { nodeArray, edges: accessibleEdges });
  }

  return { nodes: nodeArray.nodes, edges: accessibleEdges };
}

export function WorkflowCanvas() {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(displayNodesAtom);
  const edges = useAtomValue(displayEdgesAtom);
  const storeEdges = useAtomValue(edgesAtom);
  // Draft edits and run-overlay viewing are mutually exclusive: mutating while
  // the overlay is up would write the draft under a canvas that is not showing
  // it. The toolbar's Publish button reads this same atom.
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const comparison = useAtomValue(activeComparisonAtom);
  const comparisonActive = comparison !== null;
  const isGenerating = useAtomValue(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  // Below the mobile breakpoint the config rail is gone, so clicking a node has
  // to open the bottom sheet instead.
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const moveComparisonNodes = useSetAtom(moveComparisonNodesAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const connectNodes = useSetAtom(connectNodesAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const snapshotHistory = useSetAtom(snapshotHistoryAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const setComparisonSubview = useSetAtom(setComparisonSubviewAtom);
  const { screenToFlowPosition, fitView, getViewport, setViewport } =
    useReactFlow();
  // React Flow owns the semantic wrappers around custom nodes and edges. Build
  // their names from the same catalog labels the cards render, while preserving
  // element identity until the graph or catalog actually changes.
  const accessibleGraph = accessibleGraphElements(nodes, edges, catalog);
  const interaction = canvasInteractionState({
    editingLocked,
    comparisonActive,
    overlayActive,
  });
  const lifecycleNode = accessibleGraph.nodes.find(
    (node) => node.data.type === "lifecycle"
  );
  const internalLifecycleNode = useInternalNode<WorkflowNode>(
    lifecycleNode?.id ?? ""
  );
  // The same pass the Actions menu's "Tidy layout" runs.
  const { canReflow, reflow } = useReflowLayout();

  const connectingNodeId = useRef<string | null>(null);
  const connectingHandleType = useRef<"source" | "target" | null>(null);
  const connectingHandleId = useRef<string | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const [readyWorkflowId, setReadyWorkflowId] = useState<string | null>(null);
  const isCanvasReady =
    currentWorkflowId !== null && readyWorkflowId === currentWorkflowId;
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState>(null);
  const rightClickSelectionRef = useRef<ReadonlySet<string>>(new Set());
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const fittedWorkflowIdRef = useRef<string | null>(null);
  const fitGenerationRef = useRef(0);
  const { lifecycleAnchor, fitViewKey } = useSynchronizedLifecycleViewport({
    currentWorkflowId,
    lifecycleNode: lifecycleNode ?? null,
    internalNode: internalLifecycleNode
      ? {
          userNode: internalLifecycleNode.internals.userNode,
          position: internalLifecycleNode.internals.positionAbsolute,
          width: internalLifecycleNode.measured.width,
        }
      : null,
    fittedWorkflowIdRef,
    fitGenerationRef,
    readCanvasWidth: () => canvasContainerRef.current?.clientWidth,
    getZoom: () => getViewport().zoom,
    setViewport: (viewport) => setViewport(viewport, { duration: 0 }),
  });
  useDomEvent(
    window,
    "pointerdown",
    (event) => {
      if (event.button !== 2) {
        return;
      }
      rightClickSelectionRef.current = new Set(
        nodes.filter((node) => node.selected).map((node) => node.id)
      );
    },
    { capture: true, enabled: !editingLocked }
  );
  const selectedIdsAtRightClick = useCallback(
    () => rightClickSelectionRef.current,
    []
  );

  // Context menu handlers
  const { onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu } =
    useContextMenuHandlers(
      screenToFlowPosition,
      setContextMenuState,
      selectedIdsAtRightClick
    );

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  // A missing measurement must not strand the canvas invisibly. Normal loads
  // become ready in the anchor pass below; this guard handles a node that React
  // Flow could not measure and still lets a later measurement refine the view.
  useAfterDelay(currentWorkflowId, 250, () => {
    if (currentWorkflowId) {
      setReadyWorkflowId(currentWorkflowId);
    }
  });

  // Choose a useful zoom once when the workflow loads, then preserve it while
  // anchoring its Lifecycle card at the top-centre point. This initial pass
  // waits for React Flow's measurements; later workspace swaps use the
  // before-paint correction above.
  useAfterPaint(fitViewKey, () => {
    if (fitViewKey === null || !currentWorkflowId || !lifecycleAnchor) {
      return;
    }
    if (fittedWorkflowIdRef.current === currentWorkflowId) {
      return;
    }
    const fitGeneration = fitGenerationRef.current;
    fittedWorkflowIdRef.current = currentWorkflowId;
    void fitInitialWorkflowViewport({
      fitView: () =>
        fitView({
          maxZoom: 1,
          minZoom: 0.5,
          padding: 0.2,
          duration: 0,
        }),
      isCurrent: () => fitGenerationRef.current === fitGeneration,
      readAnchor: () => {
        const canvasWidth = canvasContainerRef.current?.clientWidth;
        if (!canvasWidth) {
          return null;
        }

        return {
          canvasWidth,
          nodePosition: lifecycleAnchor.position,
          nodeWidth: lifecycleAnchor.width,
          zoom: getViewport().zoom,
        };
      },
      setViewport: (viewport) => setViewport(viewport, { duration: 0 }),
      // Reveal immediately after the viewport work. The delayed guard above
      // is the only other path to readiness.
      reveal: () => setReadyWorkflowId(currentWorkflowId),
    });
  });

  // Undo/redo (Cmd+Z, Cmd+Shift+Z). Lives beside the graph it acts on rather
  // than on the editor route, so the two cannot drift apart.
  const handleUndoRedoShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "z"
      ) {
        return;
      }

      // Leave text editing alone. Node config fields are contentEditable divs,
      // so checking the tag name would miss them and steal their text undo.
      if (isTextEntry(event.target)) {
        return;
      }

      // Matches the toolbar buttons, which are disabled while generating.
      if (editingLocked) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    },
    [undo, redo, editingLocked]
  );

  useDomEvent(window, "keydown", handleUndoRedoShortcut);
  useCanvasCopyPaste(!editingLocked);
  // Mounted once, here, because the node badges and the toolbar count both read
  // what it writes and neither should run the pass itself.
  useCollectWorkflowIssues();

  const handleFitViewShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        void fitView(keyboardFitViewOptions);
      }
    },
    [fitView]
  );

  useDomEvent(window, "keydown", handleFitViewShortcut);

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) =>
      connectionRefusalReason({
        connection,
        nodes,
        edges,
        storeEdges,
        catalog,
      }) === null,
    [catalog, edges, nodes, storeEdges]
  );

  const normalizeSourceHandleForConnection = useCallback(
    (sourceNodeId: string, sourceHandle: string | null | undefined) =>
      normalizeSourceHandle({
        nodes,
        edges,
        sourceNodeId,
        sourceHandle,
        catalog,
      }),
    [nodes, edges, catalog]
  );

  const onConnect: OnConnect = useCallback(
    (connection: XYFlowConnection) => {
      if (!(connection.source && connection.target)) {
        return;
      }

      const refusal = connectionRefusalReason({
        connection,
        nodes,
        edges,
        storeEdges,
        catalog,
      });
      if (refusal) {
        toast.info(refusal, { id: "connection-refused" });
        return;
      }

      const sourceHandle = normalizeSourceHandleForConnection(
        connection.source,
        connection.sourceHandle
      );
      const newEdge = {
        id: nanoid(),
        ...connection,
        sourceHandle,
      };
      connectNodes(newEdge);
    },
    [
      normalizeSourceHandleForConnection,
      connectNodes,
      nodes,
      edges,
      storeEdges,
      catalog,
    ]
  );

  /**
   * Record the undo step for a deletion before React Flow starts removing.
   *
   * React Flow deletes in two passes, edges first and then nodes, so neither
   * change handler ever sees the whole graph. Snapshotting there recorded two
   * undo steps for one delete, and undoing once brought the node back without
   * its edges.
   */
  const onBeforeDelete = useCallback(
    ({
      nodes: nodesToDelete,
      edges: edgesToDelete,
    }: {
      nodes: WorkflowNode[];
      edges: XYFlowEdge[];
    }) => {
      // The Lifecycle Node cannot be deleted, so a selection holding only it
      // deletes nothing. Cancelling keeps its edges and skips the undo step.
      const deletesAnything =
        nodesToDelete.some((node) => node.data.type !== "lifecycle") ||
        edgesToDelete.length > 0;

      if (!deletesAnything) {
        return Promise.resolve(false);
      }

      // A Group's entry and exit are derived from the members it was built
      // from, so a member only goes when its frame does.
      if (refuseDeleteWithNotice(nodesToDelete)) {
        return Promise.resolve(false);
      }

      snapshotHistory();
      return Promise.resolve(true);
    },
    [snapshotHistory]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNode(node.id);
      if (overlayActive) {
        return;
      }
      if (comparisonActive && currentWorkflowId) {
        setComparisonSubview({
          workflowId: currentWorkflowId,
          subview: "properties",
        });
      }
      // Below the rail's breakpoint there is no panel mounted to receive the
      // selection, so selecting a node used to look like nothing happening: the
      // config lived behind an unlabelled toolbar icon a first-time user has no
      // reason to find. On a narrow canvas the tap opens the sheet itself.
      if (isMobile) {
        openSheet();
      }
    },
    [
      comparisonActive,
      currentWorkflowId,
      isMobile,
      openSheet,
      overlayActive,
      setComparisonSubview,
      setSelectedNode,
    ]
  );

  const onComparisonNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      if (currentWorkflowId) {
        moveComparisonNodes({ workflowId: currentWorkflowId, changes });
      }
    },
    [currentWorkflowId, moveComparisonNodes]
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      connectingNodeId.current = params.nodeId;
      connectingHandleType.current = params.handleType;
      connectingHandleId.current = params.handleId ?? null;
    },
    []
  );

  const getClientPosition = useCallback((event: MouseEvent | TouchEvent) => {
    const clientX =
      "changedTouches" in event
        ? event.changedTouches[0].clientX
        : event.clientX;
    const clientY =
      "changedTouches" in event
        ? event.changedTouches[0].clientY
        : event.clientY;
    return { clientX, clientY };
  }, []);

  const handleConnectionToExistingNode = useCallback(
    (nodeElement: Element) => {
      const targetNodeId = nodeElement.getAttribute("data-id");
      const fromSource = connectingHandleType.current === "source";
      const connectingId = connectingNodeId.current;

      if (targetNodeId && connectingId) {
        const sourceId = fromSource ? connectingId : targetNodeId;
        const targetId = fromSource ? targetNodeId : connectingId;
        const sourceHandle = normalizeSourceHandleForConnection(
          sourceId,
          fromSource ? connectingHandleId.current : null
        );
        const targetHandle = fromSource ? null : connectingHandleId.current;
        onConnect({
          source: sourceId,
          target: targetId,
          sourceHandle,
          targetHandle,
        });
      }
    },
    [normalizeSourceHandleForConnection, onConnect]
  );

  const handleConnectionToNewNode = useCallback(
    (clientX: number, clientY: number) => {
      const sourceNodeId = connectingNodeId.current;
      if (!sourceNodeId) {
        return;
      }

      const fromSource = connectingHandleType.current === "source";
      if (
        !(
          fromSource ||
          isValidConnection({
            source: "__new_node__",
            target: sourceNodeId,
            sourceHandle: null,
            targetHandle: null,
          })
        )
      ) {
        return;
      }

      // Client coordinates, which is what `screenToFlowPosition` takes: it
      // subtracts the pane's own rect itself. This used to hand it the release
      // point already measured from the pane's top-left, which put every node
      // made by dropping a connection up and to the left of the cursor by
      // however far the pane sat from the window's corner, over the zoom. That
      // was the menu bar's 44px, and the shell's inset and border since added
      // 13px across.
      const position = screenToFlowPosition({ x: clientX, y: clientY });

      // Center vertically on the cursor.
      position.y -= WORKFLOW_NODE_HEIGHT / 2;

      const newNode: WorkflowNode = {
        id: nanoid(),
        type: "action",
        position,
        data: {
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        },
        ariaLabel: workflowNodeAriaLabel({
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        }),
        selected: true,
      };

      addNode(newNode);
      setSelectedNode(newNode.id);

      // Deselect all other nodes and select only the new node
      // Need to do this after a delay because panOnDrag will clear selection
      setTimeout(() => {
        selectOnlyNode(newNode.id);
      }, 50);

      const sourceId = fromSource ? sourceNodeId : newNode.id;
      const targetId = fromSource ? newNode.id : sourceNodeId;
      const sourceHandle = normalizeSourceHandleForConnection(
        sourceId,
        fromSource ? connectingHandleId.current : null
      );
      const targetHandle = fromSource ? null : connectingHandleId.current;

      onConnect({
        source: sourceId,
        target: targetId,
        sourceHandle,
        targetHandle,
      });

      justCreatedNodeFromConnection.current = true;
      setTimeout(() => {
        justCreatedNodeFromConnection.current = false;
      }, 100);
    },
    [
      screenToFlowPosition,
      addNode,
      selectOnlyNode,
      setSelectedNode,
      normalizeSourceHandleForConnection,
      onConnect,
      isValidConnection,
    ]
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (!connectingNodeId.current) {
        return;
      }

      const { clientX, clientY } = getClientPosition(event);

      // Touch ends on a different target than the drag started on, so hit-test
      // the release point; mouse can use event.target.
      let target: Element | null;
      if ("changedTouches" in event) {
        target = document.elementFromPoint(clientX, clientY);
      } else if (event.target instanceof Element) {
        target = event.target;
      } else {
        target = null;
      }

      if (!target) {
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      const nodeElement = target.closest(".react-flow__node");
      const isHandle = target.closest(".react-flow__handle");
      const droppedHandleType = isHandle?.classList.contains("source")
        ? "source"
        : isHandle?.classList.contains("target")
          ? "target"
          : null;

      if (
        connectingHandleType.current &&
        droppedHandleType &&
        !connectionHandleTypesMatch(
          connectingHandleType.current,
          droppedHandleType
        )
      ) {
        toast.info("Connect an output handle to an input handle.", {
          id: "connection-refused",
        });
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      if (
        nodeElement &&
        connectingHandleType.current &&
        (!isHandle || !connectionState.isValid)
      ) {
        handleConnectionToExistingNode(nodeElement);
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      if (!(nodeElement || isHandle)) {
        handleConnectionToNewNode(clientX, clientY);
      }

      connectingNodeId.current = null;
      connectingHandleType.current = null;
      connectingHandleId.current = null;
    },
    [
      getClientPosition,
      handleConnectionToExistingNode,
      handleConnectionToNewNode,
    ]
  );

  const onPaneClick = useCallback(() => {
    // Don't deselect if we just created a node from a connection
    if (justCreatedNodeFromConnection.current) {
      return;
    }
    setSelectedNode(null);
    setSelectedEdge(null);
    closeContextMenu();
  }, [setSelectedNode, setSelectedEdge, closeContextMenu]);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: { nodes: Node[] }) => {
      // Don't clear selection if we just created a node from a connection
      if (justCreatedNodeFromConnection.current && selectedNodes.length === 0) {
        return;
      }

      if (selectedNodes.length === 0) {
        setSelectedNode(null);
      } else if (selectedNodes.length === 1) {
        setSelectedNode(selectedNodes[0].id);
      }
    },
    [setSelectedNode]
  );

  return (
    // Size comes from the editor shell, which gives this box whatever the panel
    // beside it leaves over. The shell is also where the rule against animating
    // that size lives, because React Flow observes the parent box and a
    // transition on it is what produces ResizeObserver loop warnings.
    <div
      className="relative h-full w-full bg-background"
      data-testid="workflow-canvas"
      ref={canvasContainerRef}
      style={{
        opacity: isCanvasReady ? 1 : 0,
      }}
    >
      {/* React Flow Canvas */}
      <Canvas
        className="bg-background"
        connectionLineComponent={Connection}
        connectionMode={ConnectionMode.Strict}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={interaction.deleteKeyCode}
        edges={accessibleGraph.edges}
        edgesFocusable={interaction.edgesFocusable}
        edgeTypes={edgeTypes}
        elementsSelectable={interaction.elementsSelectable}
        isValidConnection={isValidConnection}
        nodes={accessibleGraph.nodes}
        nodesConnectable={!editingLocked && !interaction.comparisonVisible}
        nodesDraggable={interaction.nodesDraggable}
        nodeTypes={nodeTypes}
        onBeforeDelete={
          interaction.comparisonVisible
            ? () => Promise.resolve(false)
            : onBeforeDelete
        }
        onConnect={editingLocked ? undefined : onConnect}
        onConnectEnd={editingLocked ? undefined : onConnectEnd}
        onConnectStart={editingLocked ? undefined : onConnectStart}
        onEdgeContextMenu={editingLocked ? undefined : onEdgeContextMenu}
        onEdgesChange={editingLocked ? undefined : onEdgesChange}
        onNodeClick={isGenerating ? undefined : onNodeClick}
        onNodeContextMenu={editingLocked ? undefined : onNodeContextMenu}
        onNodesChange={
          interaction.comparisonVisible
            ? onComparisonNodesChange
            : editingLocked
              ? undefined
              : onNodesChange
        }
        onPaneClick={onPaneClick}
        onPaneContextMenu={editingLocked ? undefined : onPaneContextMenu}
        onSelectionChange={
          interaction.elementsSelectable ? onSelectionChange : undefined
        }
      >
        <Panel
          className="border-none bg-transparent p-0"
          position="bottom-left"
        >
          <Controls canReflow={canReflow} onReflow={reflow} />
        </Panel>
        {showMinimap && (
          // maskColor and nodeColor default to hardcoded light-mode values that
          // never invert: the viewport rectangle was invisible in light (1.05:1)
          // and a bright reversed frame in dark (6.58:1). The test-mode banner
          // moved to bottom-centre, so this corner is no longer contested.
          <MiniMap
            bgColor="var(--sidebar)"
            className="rounded-lg border shadow-sm"
            maskColor="color-mix(in oklch, var(--muted) 60%, transparent)"
            nodeColor="var(--muted-foreground)"
            nodeStrokeColor="var(--border)"
          />
        )}
      </Canvas>

      {/* Context Menu */}
      <WorkflowContextMenu
        menuState={contextMenuState}
        onClose={closeContextMenu}
      />
    </div>
  );
}
