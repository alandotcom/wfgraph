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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/flow-elements/canvas";
import { Connection } from "@/components/flow-elements/connection";
import { Controls } from "@/components/flow-elements/controls";
import { WorkflowToolbar } from "@/components/workflow/workflow-toolbar";
import "@xyflow/react/dist/style.css";

import { PlayCircle, Zap } from "lucide-react";
import { nanoid } from "nanoid";
import { Edge } from "@/components/flow-elements/edge";
import { Panel } from "@/components/flow-elements/panel";
import {
  addNodeAtom,
  autosaveAtom,
  currentWorkflowIdAtom,
  edgesAtom,
  hasUnsavedChangesAtom,
  isGeneratingAtom,
  isTransitioningFromHomepageAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  propertiesPanelActiveTabAtom,
  rightPanelWidthAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
  showMinimapAtom,
  type WorkflowNode,
  type WorkflowNodeType,
} from "@/lib/workflow-store";
import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "@/shared/workflow/condition-branch";
import { ActionNode } from "./nodes/action-node";
import { AddNode } from "./nodes/add-node";
import { TriggerNode } from "./nodes/trigger-node";
import {
  type ContextMenuState,
  useContextMenuHandlers,
  WorkflowContextMenu,
} from "./workflow-context-menu";
import { layoutWorkflowNodes } from "./workflow-layout";

const nodeTemplates = [
  {
    type: "trigger" as WorkflowNodeType,
    label: "",
    description: "",
    displayLabel: "Trigger",
    icon: PlayCircle,
    defaultConfig: { triggerType: "Webhook" },
  },
  {
    type: "action" as WorkflowNodeType,
    label: "",
    description: "",
    displayLabel: "Action",
    icon: Zap,
    defaultConfig: {},
  },
];

const edgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
};

export function WorkflowCanvas() {
  const [nodes, setNodes] = useAtom(nodesAtom);
  const [edges, setEdges] = useAtom(edgesAtom);
  const [isGenerating] = useAtom(isGeneratingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
  const [isTransitioningFromHomepage, setIsTransitioningFromHomepage] = useAtom(
    isTransitioningFromHomepageAtom
  );
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const triggerAutosave = useSetAtom(autosaveAtom);
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

  // Track which workflow we've fitted view for to prevent re-running
  const fittedViewForWorkflowRef = useRef<string | null | undefined>(undefined);
  // Track if we have real nodes (not just placeholder "add" node)
  const hasRealNodes = nodes.some((n) => n.type !== "add");
  const realNodeCount = useMemo(
    () => nodes.filter((node) => node.type !== "add").length,
    [nodes]
  );
  const hadRealNodesRef = useRef(false);
  // Pre-shift viewport when transitioning from homepage (before sidebar animates)
  const hasPreShiftedRef = useRef(false);
  useEffect(() => {
    if (isTransitioningFromHomepage && !hasPreShiftedRef.current) {
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
      setViewport(
        { ...viewport, x: viewport.x - shiftPixels },
        { duration: 0 }
      );
    }
  }, [isTransitioningFromHomepage, getViewport, setViewport]);

  // Fit view when workflow changes (only on initial load, not home -> workflow)
  useEffect(() => {
    // Skip if we've already fitted view for this workflow
    if (fittedViewForWorkflowRef.current === currentWorkflowId) {
      return;
    }

    // Skip fitView for homepage -> workflow transition (viewport already set from homepage)
    if (isTransitioningFromHomepage && viewportInitialized.current) {
      fittedViewForWorkflowRef.current = currentWorkflowId;
      const readyTimer = setTimeout(() => setIsCanvasReady(true), 0);
      // Clear the flag after using it
      setIsTransitioningFromHomepage(false);
      return () => clearTimeout(readyTimer);
    }

    // Use fitView after a brief delay to ensure React Flow and nodes are ready
    const fitTimer = setTimeout(() => {
      fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
      fittedViewForWorkflowRef.current = currentWorkflowId;
      viewportInitialized.current = true;
      // Show canvas immediately so width animation can be seen
      setIsCanvasReady(true);
      // Clear the flag
      setIsTransitioningFromHomepage(false);
    }, 0);
    return () => clearTimeout(fitTimer);
  }, [
    currentWorkflowId,
    fitView,
    isTransitioningFromHomepage,
    setIsTransitioningFromHomepage,
  ]);

  // Fit view when first real node is added on homepage
  useEffect(() => {
    if (currentWorkflowId) {
      return; // Only for homepage
    }
    // Check if we just got our first real node
    if (hasRealNodes && !hadRealNodesRef.current) {
      hadRealNodesRef.current = true;
      // Fit view to center the new node
      setTimeout(() => {
        fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
        viewportInitialized.current = true;
        setIsCanvasReady(true);
      }, 0);
    } else if (!hasRealNodes) {
      // Reset when back to placeholder only
      hadRealNodesRef.current = false;
    }
  }, [currentWorkflowId, hasRealNodes, fitView]);

  // Keyboard shortcut for fit view (Cmd+/ or Ctrl+/)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Cmd+/ (Mac) or Ctrl+/ (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        fitView({ padding: 0.2, duration: 300 });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fitView]);

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
        setNodes(nextNodes);
        setHasUnsavedChanges(true);
        triggerAutosave({ immediate: true });
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
  }, [
    edges,
    fitView,
    isGenerating,
    nodes,
    realNodeCount,
    setHasUnsavedChanges,
    setNodes,
    triggerAutosave,
  ]);

  const nodeTypes = useMemo(
    () => ({
      trigger: TriggerNode,
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
        return node.type !== "trigger";
      }

      return true;
    },
    [nodes]
  );

  const isValidConnection = useCallback(
    (connection: XYFlowConnection | XYFlowEdge) => {
      const sourceNodeId = connection.source;
      const targetNodeId = connection.target;

      // Ensure we have both source and target
      if (!(sourceNodeId && targetNodeId)) {
        return false;
      }

      // Prevent self-connections
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

  const inferConditionBranch = useCallback(
    (sourceNodeId: string): "true" | "false" => {
      const outgoing = edges.filter((edge) => edge.source === sourceNodeId);
      const hasTrue = outgoing.some(
        (edge) => normalizeConditionBranch(edge.sourceHandle) === "true"
      );
      if (!hasTrue) {
        return "true";
      }

      const hasFalse = outgoing.some(
        (edge) => normalizeConditionBranch(edge.sourceHandle) === "false"
      );
      if (!hasFalse) {
        return "false";
      }

      return "true";
    },
    [edges]
  );

  const normalizeSourceHandleForConnection = useCallback(
    (sourceNodeId: string, sourceHandle: string | null | undefined) => {
      const explicitBranch = normalizeConditionBranch(sourceHandle);
      if (explicitBranch) {
        return explicitBranch;
      }

      const sourceNode = nodes.find((node) => node.id === sourceNodeId);
      if (!isConditionActionNode(sourceNode)) {
        return sourceHandle ?? null;
      }

      return inferConditionBranch(sourceNodeId);
    },
    [inferConditionBranch, nodes]
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
      setEdges((currentEdges) => [...currentEdges, newEdge]);
      setHasUnsavedChanges(true);
      // Trigger immediate autosave when nodes are connected
      triggerAutosave({ immediate: true });
    },
    [
      normalizeSourceHandleForConnection,
      isValidConnection,
      setEdges,
      setHasUnsavedChanges,
      triggerAutosave,
    ]
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

      // Get the action template
      const actionTemplate = nodeTemplates.find((t) => t.type === "action");
      if (!actionTemplate) {
        return;
      }

      // Get the position in the flow coordinate system
      const position = screenToFlowPosition({
        x: adjustedX,
        y: adjustedY,
      });

      // Center the node vertically at the cursor position
      // Node height is 192px (h-48 in Tailwind)
      const nodeHeight = 192;
      position.y -= nodeHeight / 2;

      const newNode: WorkflowNode = {
        id: nanoid(),
        type: actionTemplate.type,
        position,
        data: {
          label: actionTemplate.label,
          description: actionTemplate.description,
          type: actionTemplate.type,
          config: actionTemplate.defaultConfig,
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
        setNodes((currentNodes) =>
          currentNodes.map((n) => ({
            ...n,
            selected: n.id === newNode.id,
          }))
        );
      }, 50);

      // Create connection from the source node to the new node
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

      // Set flag to prevent immediate deselection
      justCreatedNodeFromConnection.current = true;
      setTimeout(() => {
        justCreatedNodeFromConnection.current = false;
      }, 100);
    },
    [
      calculateMenuPosition,
      screenToFlowPosition,
      addNode,
      setNodes,
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

      // Get client position first
      const { clientX, clientY } = getClientPosition(event);

      // For touch events, use elementFromPoint to get the actual element at the touch position
      // For mouse events, use event.target as before
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

      // Create connection on edge dragged over node release
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
