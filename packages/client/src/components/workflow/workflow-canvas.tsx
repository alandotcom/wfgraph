import {
  ConnectionMode,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnConnectStartParams,
  useReactFlow,
  type Connection as XYFlowConnection,
  type Edge as XYFlowEdge,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import { Canvas } from "#src/components/flow-elements/canvas";
import { Connection } from "#src/components/flow-elements/connection";
import { Controls } from "#src/components/flow-elements/controls";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import "@xyflow/react/dist/style.css";

import { nanoid } from "nanoid";
import { Edge } from "#src/components/flow-elements/edge";
import { Panel } from "#src/components/flow-elements/panel";
import { useAfterCommit, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  addNodeAtom,
  applyNodeLayoutAtom,
  connectNodesAtom,
  edgesAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  redoAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  snapshotHistoryAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
  rightPanelWidthAtom,
  showMinimapAtom,
} from "#src/lib/workflow-ui-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { normalizeSourceHandleForConnection as normalizeSourceHandle } from "./connection-handle";
import { ActionNode } from "./nodes/action-node";
import { AddNode } from "./nodes/add-node";
import { LifecycleNode } from "./nodes/lifecycle-node";
import {
  type ContextMenuState,
  useContextMenuHandlers,
  WorkflowContextMenu,
} from "./workflow-context-menu";
import { layoutWorkflowNodes } from "./workflow-layout";

const edgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
};

export function WorkflowCanvas() {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  // The sidebar renders nothing on a narrow viewport, so the canvas keeps the
  // whole width. Whether the viewport is narrow is the canvas's own question.
  const isMobile = useIsMobile();
  const sidebarWidth = useAtomValue(rightPanelWidthAtom);
  const rightPanelWidth = isMobile ? null : sidebarWidth;
  const [isTransitioningFromHomepage, setIsTransitioningFromHomepage] = useAtom(
    isTransitioningFromHomepageAtom
  );
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const applyNodeLayout = useSetAtom(applyNodeLayoutAtom);
  const connectNodes = useSetAtom(connectNodesAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const snapshotHistory = useSetAtom(snapshotHistoryAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { screenToFlowPosition, fitView, getViewport, setViewport } =
    useReactFlow();

  const connectingNodeId = useRef<string | null>(null);
  const connectingHandleType = useRef<"source" | "target" | null>(null);
  const connectingHandleId = useRef<string | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const viewportInitialized = useRef(false);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const reflowRequestId = useRef(0);
  const isReflowingRef = useRef(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [isReflowing, setIsReflowing] = useState(false);
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState>(null);

  // Context menu handlers
  const { onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu } =
    useContextMenuHandlers(screenToFlowPosition, setContextMenuState);

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  // Track if we have real nodes (not just placeholder "add" node)
  const hasRealNodes = nodes.some((n) => n.type !== "add");
  const realNodeCount = useMemo(
    () => nodes.filter((node) => node.type !== "add").length,
    [nodes]
  );
  // Pre-shift viewport when transitioning from homepage (before sidebar animates)
  const hasPreShiftedRef = useRef(false);
  useAfterCommit(isTransitioningFromHomepage, () => {
    if (!isTransitioningFromHomepage || hasPreShiftedRef.current) {
      return;
    }
    hasPreShiftedRef.current = true;

    // Check if sidebar is collapsed from cookie (atom may not be initialized yet)
    const collapsedCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-collapsed="));
    const isCollapsed = collapsedCookie?.split("=")[1] === "true";

    // Skip if sidebar is collapsed - content should stay centered
    if (isCollapsed) {
      return;
    }

    // Shift viewport left to center content in the future visible area
    // Default sidebar is 30%, so shift by 15% of window width
    const viewport = getViewport();
    const defaultSidebarPercent = 0.3;
    const shiftPixels = (window.innerWidth * defaultSidebarPercent) / 2;
    // React Flow's viewport commands resolve when their animation finishes.
    // Nothing here waits for the camera, so the promise is dropped on purpose.
    void setViewport(
      { ...viewport, x: viewport.x - shiftPixels },
      { duration: 0 }
    );
  });

  // Fit the view once per workflow. Keying on the id is the whole rule: a
  // workflow that has already been fitted does not get fitted again, and
  // switching to another one does. After paint rather than during the commit,
  // because React Flow measures node sizes then and fitView would otherwise
  // frame geometry that is a frame out of date.
  useAfterPaint(currentWorkflowId, () => {
    // Homepage -> workflow keeps the viewport the homepage already set.
    if (isTransitioningFromHomepage && viewportInitialized.current) {
      setIsCanvasReady(true);
      setIsTransitioningFromHomepage(false);
      return;
    }

    void fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
    viewportInitialized.current = true;
    // Show canvas immediately so width animation can be seen
    setIsCanvasReady(true);
    setIsTransitioningFromHomepage(false);
  });

  // On the homepage the canvas starts as a lone placeholder, so the moment a
  // real node appears there is something worth framing.
  useAfterPaint(!currentWorkflowId && hasRealNodes, () => {
    if (currentWorkflowId || !hasRealNodes) {
      return;
    }
    void fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
    viewportInitialized.current = true;
    setIsCanvasReady(true);
  });

  // Undo/redo (Cmd+Z, Cmd+Shift+Z). Lives on the canvas rather than the editor
  // route so it works on the homepage too, which is where the toolbar's undo
  // button already works.
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
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      // Matches the toolbar buttons, which are disabled while generating.
      if (isGenerating) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    },
    [undo, redo, isGenerating]
  );

  useDomEvent(window, "keydown", handleUndoRedoShortcut);

  const handleFitViewShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        void fitView({ padding: 0.2, duration: 300 });
      }
    },
    [fitView]
  );

  useDomEvent(window, "keydown", handleFitViewShortcut);

  const handleReflow = useCallback(() => {
    if (isGenerating || realNodeCount < 2 || isReflowingRef.current) {
      return;
    }

    isReflowingRef.current = true;
    setIsReflowing(true);
    const requestId = reflowRequestId.current + 1;
    reflowRequestId.current = requestId;

    try {
      const containerWidth =
        canvasContainerRef.current?.getBoundingClientRect().width ??
        (typeof window !== "undefined" ? window.innerWidth : undefined);
      const { nodes: nextNodes, changed } = layoutWorkflowNodes({
        nodes,
        edges,
        availableWidth: containerWidth,
      });

      if (requestId !== reflowRequestId.current) {
        return;
      }

      if (changed) {
        applyNodeLayout(nextNodes);
      }

      window.requestAnimationFrame(() => {
        Promise.resolve(
          fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 300 })
        ).catch(() => undefined);
      });
    } finally {
      if (requestId === reflowRequestId.current) {
        isReflowingRef.current = false;
        setIsReflowing(false);
      }
    }
  }, [applyNodeLayout, edges, fitView, isGenerating, nodes, realNodeCount]);

  const nodeTypes = useMemo(
    () => ({
      lifecycle: LifecycleNode,
      action: ActionNode,
      add: AddNode,
    }),
    []
  );

  const nodeHasHandle = useCallback(
    (nodeId: string, handleType: "source" | "target") => {
      const node = nodes.find((n) => n.id === nodeId);

      if (!node) {
        return false;
      }

      if (node.type === "add") {
        return false;
      }

      if (handleType === "target") {
        return node.type !== "lifecycle";
      }

      return true;
    },
    [nodes]
  );

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) => {
      const sourceNodeId = connection.source;
      const targetNodeId = connection.target;

      if (!(sourceNodeId && targetNodeId)) {
        return false;
      }

      if (sourceNodeId === targetNodeId) {
        return false;
      }

      const connectionId =
        "id" in connection && typeof connection.id === "string"
          ? connection.id
          : null;
      const conflictingIncomingEdge = edges.find(
        (edge) => edge.target === targetNodeId && edge.id !== connectionId
      );
      if (conflictingIncomingEdge) {
        return false;
      }

      return true;
    },
    [edges]
  );

  const normalizeSourceHandleForConnection = useCallback(
    (sourceNodeId: string, sourceHandle: string | null | undefined) =>
      normalizeSourceHandle({ nodes, edges, sourceNodeId, sourceHandle }),
    [nodes, edges]
  );

  const onConnect: OnConnect = useCallback(
    (connection: XYFlowConnection) => {
      if (!(connection.source && connection.target)) {
        return;
      }

      if (!isValidConnection(connection)) {
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
        type: "animated",
      };
      connectNodes(newEdge);
    },
    [normalizeSourceHandleForConnection, isValidConnection, connectNodes]
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

      snapshotHistory();
      return Promise.resolve(true);
    },
    [snapshotHistory]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNode(node.id);
    },
    [setSelectedNode]
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

  const calculateMenuPosition = useCallback(
    (event: MouseEvent | TouchEvent, clientX: number, clientY: number) => {
      const eventTarget =
        event.target instanceof Element ? event.target : undefined;
      const reactFlowBounds = eventTarget
        ?.closest(".react-flow")
        ?.getBoundingClientRect();

      const adjustedX = reactFlowBounds
        ? clientX - reactFlowBounds.left
        : clientX;
      const adjustedY = reactFlowBounds
        ? clientY - reactFlowBounds.top
        : clientY;

      return { adjustedX, adjustedY };
    },
    []
  );

  const handleConnectionToExistingNode = useCallback(
    (nodeElement: Element) => {
      const targetNodeId = nodeElement.getAttribute("data-id");
      const fromSource = connectingHandleType.current === "source";
      const requiredHandle = fromSource ? "target" : "source";
      const connectingId = connectingNodeId.current;

      if (
        targetNodeId &&
        connectingId &&
        targetNodeId !== connectingId &&
        nodeHasHandle(targetNodeId, requiredHandle)
      ) {
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
    [nodeHasHandle, normalizeSourceHandleForConnection, onConnect]
  );

  const handleConnectionToNewNode = useCallback(
    (event: MouseEvent | TouchEvent, clientX: number, clientY: number) => {
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

      const { adjustedX, adjustedY } = calculateMenuPosition(
        event,
        clientX,
        clientY
      );

      const position = screenToFlowPosition({
        x: adjustedX,
        y: adjustedY,
      });

      // Center vertically on the cursor; node height is h-48 (192px).
      const nodeHeight = 192;
      position.y -= nodeHeight / 2;

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
        selected: true,
      };

      addNode(newNode);
      setSelectedNode(newNode.id);
      setActiveTab("properties");

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
      calculateMenuPosition,
      screenToFlowPosition,
      addNode,
      selectOnlyNode,
      setSelectedNode,
      setActiveTab,
      normalizeSourceHandleForConnection,
      onConnect,
      isValidConnection,
    ]
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
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

      if (nodeElement && !isHandle && connectingHandleType.current) {
        handleConnectionToExistingNode(nodeElement);
        connectingNodeId.current = null;
        connectingHandleType.current = null;
        connectingHandleId.current = null;
        return;
      }

      if (!(nodeElement || isHandle)) {
        handleConnectionToNewNode(event, clientX, clientY);
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
    <div
      className="relative h-full bg-background"
      data-testid="workflow-canvas"
      ref={canvasContainerRef}
      style={{
        opacity: isCanvasReady ? 1 : 0,
        width: rightPanelWidth ? `calc(100% - ${rightPanelWidth})` : "100%",
        // Avoid animating container width: React Flow observes parent size and
        // width transitions can trigger noisy ResizeObserver loop warnings.
        transition: "opacity 300ms",
      }}
    >
      {/* Toolbar */}
      <div className="pointer-events-auto">
        <WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
      </div>

      {/* React Flow Canvas */}
      <Canvas
        className="bg-background"
        connectionLineComponent={Connection}
        connectionMode={ConnectionMode.Strict}
        edges={edges}
        edgeTypes={edgeTypes}
        elementsSelectable={!isGenerating}
        isValidConnection={isValidConnection}
        nodes={nodes}
        nodesConnectable={!isGenerating}
        nodesDraggable={!isGenerating}
        nodeTypes={nodeTypes}
        onBeforeDelete={onBeforeDelete}
        onConnect={isGenerating ? undefined : onConnect}
        onConnectEnd={isGenerating ? undefined : onConnectEnd}
        onConnectStart={isGenerating ? undefined : onConnectStart}
        onEdgeContextMenu={isGenerating ? undefined : onEdgeContextMenu}
        onEdgesChange={isGenerating ? undefined : onEdgesChange}
        onNodeClick={isGenerating ? undefined : onNodeClick}
        onNodeContextMenu={isGenerating ? undefined : onNodeContextMenu}
        onNodesChange={isGenerating ? undefined : onNodesChange}
        onPaneClick={onPaneClick}
        onPaneContextMenu={isGenerating ? undefined : onPaneContextMenu}
        onSelectionChange={isGenerating ? undefined : onSelectionChange}
      >
        <Panel
          className="workflow-controls-panel border-none bg-transparent p-0"
          position="bottom-left"
        >
          <Controls
            canReflow={!isGenerating && realNodeCount > 1 && !isReflowing}
            onReflow={isGenerating ? undefined : handleReflow}
          />
        </Panel>
        {showMinimap && (
          <MiniMap bgColor="var(--sidebar)" nodeStrokeColor="var(--border)" />
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
