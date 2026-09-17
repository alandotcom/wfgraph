import {
  ConnectionMode,
  MiniMap,
  type NodeMouseHandler,
  useInternalNode,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
  type Edge as XYFlowEdge,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import { Canvas } from "#src/components/flow-elements/canvas";
import { Connection } from "#src/components/flow-elements/connection";
import { Controls } from "#src/components/flow-elements/controls";
import "@xyflow/react/dist/style.css";

import { Edge } from "#src/components/flow-elements/edge";
import { Panel } from "#src/components/flow-elements/panel";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useAfterDelay, useAfterPaint, useDomEvent } from "#src/hooks/effects";
import { isTextEntry } from "#src/lib/is-text-entry";
import { viewportAnimationDuration } from "#src/lib/motion";
import {
  canvasGraphAtom,
  displayNodesAtom,
  edgesAtom,
  canvasEditingLockedAtom,
  deleteSelectedItemsAtom,
  executionOverlayGraphAtom,
  isExecutionOverlayActiveAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  redoAtom,
  canvasSelectionAtom,
  snapshotHistoryAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import {
  activeComparisonAtom,
  moveComparisonNodesAtom,
} from "#src/lib/workflow-comparison-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  isGeneratingAtom,
  showMinimapAtom,
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { WORKFLOW_EDGE_TYPE } from "#src/lib/workflow-graph-types";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { ActionNode } from "./nodes/action-node";
import { AddNode } from "./nodes/add-node";
import {
  GroupChangedStepsSlot,
  type GroupChangedStepsControlProps,
  GroupNode,
} from "./nodes/group-node";
import { GroupChangedStepsButton } from "./canvas-reveal/changes-navigation";
import { groupBoundaryNodeTypes } from "./nodes/group-boundary-node";
import { GroupScopeBar } from "./group-scope-bar";
import { useGroupScopeNavigation } from "./use-group-scope-navigation";
import { withoutProjectedDimensions } from "#src/lib/group-scope-canvas";
import { scopeId } from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  groupScopeActiveAtom,
} from "#src/lib/workflow-workspace-navigation";
import { LifecycleNode } from "./nodes/lifecycle-node";
import { useCanvasConnections } from "./use-canvas-connections";
import { useCanvasCopyPaste } from "./use-canvas-copy-paste";
import { useReflowLayout } from "./use-reflow-layout";
import { useWorkspaceCamera } from "./use-workspace-camera";
import { useRevealCamera } from "./canvas-reveal/use-reveal-camera";
import { useRevealOccupiedWidth } from "./canvas-reveal/use-reveal-width";
import { CANVAS_OBSTACLE_SLOTS } from "./canvas-reveal/reveal-geometry";
import { useCollectWorkflowIssues } from "#src/hooks/use-workflow-issues";
import {
  useClearWorkflowNodeInspection,
  useWorkflowNodeInspection,
} from "./use-workflow-node-inspection";
import {
  type ContextMenuState,
  useContextMenuHandlers,
  WorkflowContextMenu,
} from "./workflow-context-menu";
import { WORKFLOW_NODE_WIDTH } from "#src/lib/workflow-node-dimensions";
import { accessibleGraphElements } from "./workflow-canvas-accessibility";
import {
  canvasSynchronizationKey,
  canvasViewportCorrectionKey,
  fitInitialWorkflowViewport,
  keyboardFitViewOptions,
  synchronizeCanvasGraph,
  useFitWorkflowGraph,
  useSynchronizedCanvas,
} from "./workflow-canvas-synchronization";
import {
  WORKFLOW_CANVAS_MIN_ZOOM,
  presentationViewport,
  workflowFitViewOptions,
} from "./workflow-viewport";

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

/** The changed-steps control a Group card draws on a comparison canvas. */
function renderGroupChangedSteps(props: GroupChangedStepsControlProps) {
  return <GroupChangedStepsButton {...props} />;
}

const nodeTypes = {
  lifecycle: LifecycleNode,
  action: ActionNode,
  add: AddNode,
  group: GroupNode,
  ...groupBoundaryNodeTypes,
};

export function canvasInteractionState({
  editingLocked,
  comparisonActive,
  overlayActive,
  groupScopeActive,
}: {
  editingLocked: boolean;
  comparisonActive: boolean;
  overlayActive: boolean;
  /** A focused Group canvas, which inserts no node until it can edit topology. */
  groupScopeActive: boolean;
}) {
  const comparisonVisible = comparisonActive && !overlayActive;
  return {
    comparisonVisible,
    /** Whether adding, pasting, and duplicating steps is offered. */
    insertsNodes: !editingLocked && !comparisonVisible && !groupScopeActive,
    elementsSelectable: !editingLocked || comparisonVisible,
    nodesDraggable: !editingLocked || comparisonVisible,
    edgesFocusable: !comparisonVisible,
    deleteKeyCode: comparisonVisible ? null : ["Backspace", "Delete"],
  };
}

export function WorkflowCanvas({ canEdit }: { canEdit: boolean }) {
  const catalog = useExtensionCatalog();
  // What the active scope paints, and every node of the graph, which the
  // connection rules read because a Group frame stands for its members.
  const canvasGraph = useAtomValue(canvasGraphAtom);
  const { nodes, edges } = canvasGraph;
  const graphNodes = useAtomValue(displayNodesAtom);
  const { scope } = useAtomValue(activeWorkspaceAddressAtom);
  const groupScopeActive = useAtomValue(groupScopeActiveAtom);
  const { onNodeDoubleClick } = useGroupScopeNavigation();
  const storeEdges = useAtomValue(edgesAtom);
  // Draft edits and run-overlay viewing are mutually exclusive: mutating while
  // the overlay is up would write the draft under a canvas that is not showing
  // it. The toolbar's Publish button reads this same atom.
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const executionOverlay = useAtomValue(executionOverlayGraphAtom);
  const comparison = useAtomValue(activeComparisonAtom);
  const comparisonActive = comparison !== null;
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const isGenerating = useAtomValue(isGeneratingAtom);
  const workflowGraphUpdate = useAtomValue(workflowGraphUpdateAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [showMinimap] = useAtom(showMinimapAtom);
  const revealOccupiedWidth = useRevealOccupiedWidth();
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const moveComparisonNodes = useSetAtom(moveComparisonNodesAtom);
  const onEdgesChange = useSetAtom(onEdgesChangeAtom);
  const selection = useAtomValue(canvasSelectionAtom);
  const clearSelection = useClearWorkflowNodeInspection();
  const snapshotHistory = useSetAtom(snapshotHistoryAtom);
  const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
  const undo = useSetAtom(undoAtom);
  const redo = useSetAtom(redoAtom);
  const inspectNode = useWorkflowNodeInspection();
  const {
    screenToFlowPosition,
    fitView,
    getNodesBounds,
    getViewport,
    setViewport,
  } = useReactFlow();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const fittedWorkflowIdRef = useRef<string | null>(null);
  /** Whether the canvas has made its first placement for a workflow. */
  const isCanvasPlaced = (workflowId: string) =>
    fittedWorkflowIdRef.current === workflowId;
  // React Flow owns the semantic wrappers around custom nodes and edges. Build
  // their names from the same catalog labels the cards render, while preserving
  // element identity until the graph or catalog actually changes.
  const accessibleGraph = accessibleGraphElements(nodes, edges, catalog);
  // The node whose measurement tells the first placement that React Flow holds
  // the graph, which the placement pins near the top when the scope asks.
  const anchorNode = accessibleGraph.nodes.find(
    (node) => node.id === canvasGraph.anchor?.nodeId
  );
  const pinnedAnchor = canvasGraph.anchor?.pinToTop ? anchorNode : undefined;
  // Declared ahead of the synchronized canvas below, so the camera of the
  // workspace being left is stored before any placement for the next one.
  const workspaceCamera = useWorkspaceCamera({
    isCanvasPlaced,
    paintedNodes: accessibleGraph.nodes,
    revealOccupiedWidth,
  });
  const fitGenerationRef = useRef(0);
  const canvasPresentation = canvasSynchronizationKey({
    workspaceView,
    executionOverlay,
    comparison,
    draftEdges: storeEdges,
    scope: scopeId(scope),
  });
  const resolvedWorkspacePresentation =
    workspaceView === "runs"
      ? executionOverlay
      : workspaceView === "changes"
        ? comparison
        : null;
  const viewportCorrection = useMemo(
    () =>
      canvasViewportCorrectionKey({
        workflowId: currentWorkflowId,
        workspaceView,
        presentation: resolvedWorkspacePresentation,
      }),
    [currentWorkflowId, workspaceView, resolvedWorkspacePresentation]
  );
  const reactFlowStore = useStoreApi<WorkflowNode, WorkflowEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const synchronizeGraph = () => {
    const state = reactFlowStore.getState();
    return synchronizeCanvasGraph({
      nodes: accessibleGraph.nodes,
      edges: accessibleGraph.edges,
      currentNodes: state.nodes,
      currentEdges: state.edges,
      setNodes: state.setNodes,
      setEdges: state.setEdges,
    });
  };
  const correctViewport = () => {
    const canvasWidth = canvasContainerRef.current?.clientWidth;
    const canvasHeight = canvasContainerRef.current?.clientHeight;
    if (
      currentWorkflowId &&
      fittedWorkflowIdRef.current === currentWorkflowId &&
      pinnedAnchor &&
      canvasWidth &&
      canvasHeight
    ) {
      fitGenerationRef.current += 1;
      if (workspaceCamera.placeReplacedGraph()) {
        return;
      }
      void setViewport(
        presentationViewport({
          canvas: { width: canvasWidth, height: canvasHeight },
          currentViewport: getViewport(),
          graphBounds: getNodesBounds(accessibleGraph.nodes),
          lifecycle: {
            nodePosition: pinnedAnchor.position,
            nodeWidth:
              pinnedAnchor.measured?.width ??
              pinnedAnchor.width ??
              pinnedAnchor.initialWidth ??
              WORKFLOW_NODE_WIDTH,
            top: 48,
          },
        }),
        { duration: 0 }
      );
    }
  };
  const graphEditingLocked = editingLocked || !canEdit;
  const interaction = canvasInteractionState({
    editingLocked: graphEditingLocked,
    comparisonActive,
    overlayActive,
    groupScopeActive,
  });
  const internalAnchorNode = useInternalNode<WorkflowNode>(
    anchorNode?.id ?? ""
  );
  // The same pass the Actions menu's "Tidy layout" runs.
  const { canReflow, reflow } = useReflowLayout();

  const [readyWorkflowId, setReadyWorkflowId] = useState<string | null>(null);
  const isCanvasReady =
    currentWorkflowId !== null && readyWorkflowId === currentWorkflowId;
  // The workspace camera restores a scope's saved camera before paint, and
  // Canvas Reveal's camera runs after paint, so a placement always compares
  // against the restored camera.
  const revealCamera = useRevealCamera({
    isCanvasPlaced,
    isCanvasReady,
    canvas: canvasContainerRef,
  });
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState>(null);
  const rightClickSelectionRef = useRef<ReadonlySet<string>>(new Set());
  const { lifecycleAnchor, fitViewKey } = useSynchronizedCanvas({
    // React Flow applies controlled graph props in a passive effect. Install
    // the incoming graph during the layout phase, then correct the viewport for
    // a resolved workspace replacement before the browser can paint it.
    // Draft uses stored edge identity so route hydration also replaces React
    // Flow's graph, while node-only drag updates keep the key stable.
    presentation: canvasPresentation,
    synchronizePresentation: synchronizeGraph,
    viewportCorrection,
    correctViewport,
    remeasureNodes: updateNodeInternals,
    nodeIds: accessibleGraph.nodes.map((node) => node.id),
    currentWorkflowId,
    lifecycleNode: anchorNode ?? null,
    internalNode: internalAnchorNode
      ? {
          userNode: internalAnchorNode.internals.userNode,
          position: internalAnchorNode.internals.positionAbsolute,
          width: internalAnchorNode.measured.width,
        }
      : null,
    fitGenerationRef,
  });
  useFitWorkflowGraph({
    update: workflowGraphUpdate,
    workflowId: currentWorkflowId,
    beforeFit: () => {
      fitGenerationRef.current += 1;
    },
    fitView: () =>
      fitView({
        ...workflowFitViewOptions(viewportAnimationDuration()),
      }),
  });
  useDomEvent(
    window,
    "pointerdown",
    (event) => {
      if (event.button !== 2) {
        return;
      }
      rightClickSelectionRef.current = new Set(selection.nodeIds);
    },
    { capture: true, enabled: !graphEditingLocked }
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
  }, [setContextMenuState]);

  // A missing measurement must not strand the canvas invisibly. Normal loads
  // become ready in the anchor pass below; this guard handles a node that React
  // Flow could not measure and still lets a later measurement refine the view.
  useAfterDelay(currentWorkflowId, 250, () => {
    if (currentWorkflowId) {
      setReadyWorkflowId(currentWorkflowId);
    }
  });

  // Choose a useful zoom once when the workflow loads. This initial pass waits
  // for React Flow's measurements; resolved workspace swaps preserve zoom and
  // locate their incoming graph before paint.
  useAfterPaint(fitViewKey, () => {
    if (fitViewKey === null || !currentWorkflowId || !lifecycleAnchor) {
      return;
    }
    if (fittedWorkflowIdRef.current === currentWorkflowId) {
      return;
    }
    const fitGeneration = fitGenerationRef.current;
    fittedWorkflowIdRef.current = currentWorkflowId;
    // A workflow reopened in the same session returns to the camera its
    // workspace was left with.
    const savedViewport = workspaceCamera.savedViewport();
    if (savedViewport) {
      void setViewport(savedViewport, { duration: 0 });
      setReadyWorkflowId(currentWorkflowId);
      return;
    }
    void fitInitialWorkflowViewport({
      fitView: () =>
        fitView({
          ...workflowFitViewOptions(0),
        }),
      isCurrent: () => fitGenerationRef.current === fitGeneration,
      readAnchor: () => {
        const canvasWidth = canvasContainerRef.current?.clientWidth;
        const canvasHeight = canvasContainerRef.current?.clientHeight;
        if (!canvasWidth || !canvasHeight || !canvasGraph.anchor?.pinToTop) {
          return null;
        }

        return {
          canvasWidth,
          canvasHeight,
          graphBounds: getNodesBounds(accessibleGraph.nodes),
          nodePosition: lifecycleAnchor.position,
          nodeWidth: lifecycleAnchor.width,
          fittedViewport: getViewport(),
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
      if (graphEditingLocked) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    },
    [undo, redo, graphEditingLocked]
  );

  useDomEvent(window, "keydown", handleUndoRedoShortcut);
  useCanvasCopyPaste({
    enabled: !graphEditingLocked,
    insertsNodes: interaction.insertsNodes,
  });
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
      if (graphEditingLocked) {
        return Promise.resolve(false);
      }
      // The Lifecycle Node cannot be deleted, so a selection holding only it
      // deletes nothing. Cancelling keeps its edges and skips the undo step.
      const deletesAnything =
        nodesToDelete.some((node) => node.data.type !== "lifecycle") ||
        edgesToDelete.length > 0;

      if (!deletesAnything) {
        return Promise.resolve(false);
      }

      // Removing a frame ungroups it. React Flow would instead take every
      // member and the painted edges on the frame's handles, which stand for
      // stored edges on the members. A batch holding a frame is therefore
      // handed to the store's selection delete, which removes only the selected
      // members and records its own undo step. The delete key only ever deletes
      // the selection, so both name one batch.
      if (nodesToDelete.some((node) => isGroupNode(node))) {
        deleteSelectedItems();
        return Promise.resolve(false);
      }

      snapshotHistory();
      return Promise.resolve(true);
    },
    [deleteSelectedItems, graphEditingLocked, snapshotHistory]
  );

  // React Flow writes the selection itself through `select` changes wherever
  // it receives the node change handler for the Draft; everywhere else a click
  // selects the node here.
  const canvasWritesSelection =
    !graphEditingLocked && !interaction.comparisonVisible;
  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) =>
      inspectNode(node.id, { selectionApplied: canvasWritesSelection }),
    [canvasWritesSelection, inspectNode]
  );

  const onComparisonNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      if (currentWorkflowId) {
        moveComparisonNodes({ workflowId: currentWorkflowId, changes });
      }
    },
    [currentWorkflowId, moveComparisonNodes]
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      if (graphEditingLocked) {
        return;
      }
      onNodesChange(
        withoutProjectedDimensions(changes, canvasGraph.projectedNodeIds)
      );
    },
    [canvasGraph.projectedNodeIds, graphEditingLocked, onNodesChange]
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      if (graphEditingLocked) {
        return;
      }
      onEdgesChange(changes);
    },
    [graphEditingLocked, onEdgesChange]
  );

  const {
    isValidConnection,
    onConnect,
    onConnectStart,
    onConnectEnd,
    wasNodeJustCreatedFromConnection,
  } = useCanvasConnections({
    nodes,
    graphNodes,
    storeEdges,
    catalog,
    graphEditingLocked,
    insertsNodes: interaction.insertsNodes,
    screenToFlowPosition,
  });

  const onPaneClick = useCallback(() => {
    // Don't deselect if we just created a node from a connection
    if (wasNodeJustCreatedFromConnection()) {
      return;
    }
    clearSelection();
    closeContextMenu();
  }, [clearSelection, closeContextMenu, wasNodeJustCreatedFromConnection]);

  return (
    // Size comes from the canvas box, which Canvas Reveal floats over without
    // resizing. Nothing animates that size, because React Flow observes the
    // parent box and a transition on it produces ResizeObserver loop warnings.
    <div
      className="relative h-full w-full bg-background"
      data-testid="workflow-canvas"
      ref={canvasContainerRef}
      style={{
        opacity: isCanvasReady ? 1 : 0,
      }}
    >
      {/* React Flow Canvas. A Group card on a comparison canvas leads to its
          changed steps through the control the slot supplies. */}
      <GroupChangedStepsSlot.Provider value={renderGroupChangedSteps}>
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
          minZoom={WORKFLOW_CANVAS_MIN_ZOOM}
          nodes={accessibleGraph.nodes}
          nodesConnectable={
            !graphEditingLocked && !interaction.comparisonVisible
          }
          nodesDraggable={interaction.nodesDraggable}
          nodeTypes={nodeTypes}
          onBeforeDelete={
            interaction.comparisonVisible
              ? () => Promise.resolve(false)
              : onBeforeDelete
          }
          onConnect={graphEditingLocked ? undefined : onConnect}
          onConnectEnd={graphEditingLocked ? undefined : onConnectEnd}
          onConnectStart={graphEditingLocked ? undefined : onConnectStart}
          onEdgeContextMenu={graphEditingLocked ? undefined : onEdgeContextMenu}
          onEdgesChange={graphEditingLocked ? undefined : handleEdgesChange}
          onNodeClick={isGenerating ? undefined : onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeContextMenu={graphEditingLocked ? undefined : onNodeContextMenu}
          onNodesChange={
            interaction.comparisonVisible
              ? onComparisonNodesChange
              : graphEditingLocked
                ? undefined
                : handleNodesChange
          }
          onMoveEnd={() => {
            workspaceCamera.onMoveEnd();
            revealCamera.onMoveEnd();
          }}
          onMoveStart={workspaceCamera.onMoveStart}
          onPaneClick={onPaneClick}
          onPaneContextMenu={graphEditingLocked ? undefined : onPaneContextMenu}
        >
          <Panel
            className="[--workflow-controls-bottom:3.5rem] border-none bg-transparent p-0 md:[--workflow-controls-bottom:0px]"
            data-slot={CANVAS_OBSTACLE_SLOTS.controls}
            position="bottom-left"
            style={{ bottom: "var(--workflow-controls-bottom)" }}
          >
            <Controls
              canReflow={!graphEditingLocked && canReflow}
              onReflow={graphEditingLocked ? undefined : reflow}
            />
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
              pannable
              // Sits beside open Canvas Reveal. The panel's own margin keeps the
              // gap to Reveal's edge.
              style={{ right: revealOccupiedWidth }}
              zoomable
            />
          )}
        </Canvas>
      </GroupChangedStepsSlot.Provider>

      <GroupScopeBar />

      {/* Context Menu */}
      <WorkflowContextMenu
        canEdit={canEdit}
        canInsert={interaction.insertsNodes}
        menuState={contextMenuState}
        onClose={closeContextMenu}
      />
    </div>
  );
}
