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
import { useCallback, useRef, useState } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { Canvas } from "#src/components/flow-elements/canvas";
import { Connection } from "#src/components/flow-elements/connection";
import { Controls } from "#src/components/flow-elements/controls";
import "@xyflow/react/dist/style.css";

import { nanoid } from "nanoid";
import { andJoinRefusalReason } from "@wfgraph/shared/graph/and-join";
import { Edge } from "#src/components/flow-elements/edge";
import { Panel } from "#src/components/flow-elements/panel";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useAfterCommit, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { isTextEntry } from "#src/lib/is-text-entry";
import {
  addNodeAtom,
  connectNodesAtom,
  displayEdgesAtom,
  displayNodesAtom,
  edgesAtom,
  canvasEditingLockedAtom,
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
  isTransitioningFromHomepageAtom,
  propertiesPanelActiveTabAtom,
  showMinimapAtom,
} from "#src/lib/workflow-ui-store";
import { WORKFLOW_EDGE_TYPE } from "#src/lib/workflow-graph-types";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { fanOutStoreEdges } from "@wfgraph/shared/graph/node-group";
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

export function WorkflowCanvas() {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(displayNodesAtom);
  const edges = useAtomValue(displayEdgesAtom);
  const storeEdges = useAtomValue(edgesAtom);
  // Draft edits and run-overlay viewing are mutually exclusive: mutating while
  // the overlay is up would write the draft under a canvas that is not showing
  // it. The toolbar's Publish button reads this same atom.
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  // Below the mobile breakpoint the config rail is gone, so clicking a node has
  // to open the bottom sheet instead.
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
  const [isTransitioningFromHomepage, setIsTransitioningFromHomepage] = useAtom(
    isTransitioningFromHomepageAtom
  );
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setSelectedEdge = useSetAtom(selectedEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const connectNodes = useSetAtom(connectNodesAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const snapshotHistory = useSetAtom(snapshotHistoryAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { screenToFlowPosition, fitView, getViewport, setViewport } =
    useReactFlow();
  // The same pass the Actions menu's "Tidy layout" runs.
  const { canReflow, reflow } = useReflowLayout();

  const connectingNodeId = useRef<string | null>(null);
  const connectingHandleType = useRef<"source" | "target" | null>(null);
  const connectingHandleId = useRef<string | null>(null);
  const justCreatedNodeFromConnection = useRef(false);
  const viewportInitialized = useRef(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState>(null);
  const rightClickSelectionRef = useRef<ReadonlySet<string>>(new Set());
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

  // Track if we have real nodes (not just placeholder "add" node)
  const hasRealNodes = nodes.some((n) => n.type !== "add");
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
        void fitView({ padding: 0.2, duration: 300 });
      }
    },
    [fitView]
  );

  useDomEvent(window, "keydown", handleFitViewShortcut);

  const nodeHasHandle = useCallback(
    (nodeId: string, handleType: "source" | "target") => {
      const node = nodes.find((n) => n.id === nodeId);

      if (!node) {
        return false;
      }

      if (node.type === "add" || node.parentId) {
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

      const sourceNode = nodes.find((node) => node.id === sourceNodeId);
      const targetNode = nodes.find((node) => node.id === targetNodeId);
      if (sourceNode?.parentId || targetNode?.parentId) {
        return false;
      }

      const connectionId =
        "id" in connection && typeof connection.id === "string"
          ? connection.id
          : null;
      const sourceHandle = normalizeSourceHandle({
        nodes,
        edges,
        sourceNodeId,
        sourceHandle:
          "sourceHandle" in connection ? connection.sourceHandle : undefined,
        catalog,
      });
      const additions = fanOutStoreEdges({
        nodes,
        edges: storeEdges,
        sourceId: sourceNodeId,
        targetId: targetNodeId,
        sourceHandle,
        excludeEdgeId: connectionId,
      });
      if (additions.length === 0) {
        return false;
      }

      const proposedEdges = [
        ...storeEdges.filter((edge) => edge.id !== connectionId),
        ...additions,
      ];

      if (
        andJoinRefusalReason({
          nodes,
          edges: proposedEdges,
        })
      ) {
        return false;
      }

      return true;
    },
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
      setActiveTab("properties");
      // Below the rail's breakpoint there is no panel mounted to receive the
      // selection, so selecting a node used to look like nothing happening: the
      // config lived behind an unlabelled toolbar icon a first-time user has no
      // reason to find. On a narrow canvas the tap opens the sheet itself.
      if (isMobile) {
        openSheet();
      }
    },
    [setSelectedNode, setActiveTab, isMobile, openSheet]
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
      style={{
        opacity: isCanvasReady ? 1 : 0,
        transition: "opacity 300ms",
      }}
    >
      {/* React Flow Canvas */}
      <Canvas
        className="bg-background"
        connectionLineComponent={Connection}
        connectionMode={ConnectionMode.Strict}
        defaultEdgeOptions={defaultEdgeOptions}
        edges={edges}
        edgeTypes={edgeTypes}
        elementsSelectable={!editingLocked}
        isValidConnection={isValidConnection}
        nodes={nodes}
        nodesConnectable={!editingLocked}
        nodesDraggable={!editingLocked}
        nodeTypes={nodeTypes}
        onBeforeDelete={onBeforeDelete}
        onConnect={editingLocked ? undefined : onConnect}
        onConnectEnd={editingLocked ? undefined : onConnectEnd}
        onConnectStart={editingLocked ? undefined : onConnectStart}
        onEdgeContextMenu={editingLocked ? undefined : onEdgeContextMenu}
        onEdgesChange={editingLocked ? undefined : onEdgesChange}
        onNodeClick={editingLocked ? undefined : onNodeClick}
        onNodeContextMenu={editingLocked ? undefined : onNodeContextMenu}
        onNodesChange={editingLocked ? undefined : onNodesChange}
        onPaneClick={onPaneClick}
        onPaneContextMenu={editingLocked ? undefined : onPaneContextMenu}
        onSelectionChange={editingLocked ? undefined : onSelectionChange}
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
