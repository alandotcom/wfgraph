import { useRef } from "react";
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowGraphUpdate } from "#src/lib/workflow-ui-store";
import {
  initialWorkflowViewport,
  workflowFitViewOptions,
} from "./workflow-viewport";
export { lifecycleAnchorViewport } from "./workflow-viewport";

type InternalLifecycleAnchor = {
  userNode: WorkflowNode;
  position: { x: number; y: number };
  width: number | undefined;
};

const EMPTY_RUN_PRESENTATION = {};
const EMPTY_CHANGES_PRESENTATION = {};

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

export const keyboardFitViewOptions = workflowFitViewOptions(0);

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

export function useSynchronizedCanvas({
  presentation,
  synchronizePresentation,
  viewportCorrection,
  correctViewport,
  currentWorkflowId,
  lifecycleNode,
  internalNode,
  fitGenerationRef,
}: {
  presentation: unknown;
  synchronizePresentation: () => void;
  viewportCorrection: unknown;
  correctViewport: () => void;
  currentWorkflowId: string | null;
  lifecycleNode: WorkflowNode | null;
  internalNode: InternalLifecycleAnchor | null;
  fitGenerationRef: { current: number };
}): {
  lifecycleAnchor: ReturnType<typeof synchronizedLifecycleAnchor>;
  fitViewKey: string | null;
} {
  useBeforePaint(presentation, synchronizePresentation);
  useBeforePaint(viewportCorrection, () => {
    if (viewportCorrection !== null) {
      correctViewport();
    }
  });

  const lifecycleAnchor = synchronizedLifecycleAnchor(
    lifecycleNode,
    internalNode
  );
  const fitViewKey = canvasFitViewKey({
    workflowId: currentWorkflowId,
    lifecycleNode: lifecycleAnchor,
  });

  // Controlled props reach React Flow's internal store after this component
  // renders. Wait for its node identity so initial fitting never reads the
  // outgoing graph. The canvas corrects a resolved replacement before paint.
  useBeforePaint(fitViewKey, () => {
    fitGenerationRef.current += 1;
  });

  return { lifecycleAnchor, fitViewKey };
}

/**
 * Identifies a resolved workspace replacement that should relocate the canvas.
 * Draft edge changes use a separate synchronization key, so editing a Draft
 * never changes this value or resets the user's viewport.
 */
export function canvasViewportCorrectionKey({
  workflowId,
  workspaceView,
  presentation,
}: {
  workflowId: string | null;
  workspaceView: "draft" | "runs" | "changes";
  presentation: unknown;
}): {
  workflowId: string;
  workspaceView: "draft" | "runs" | "changes";
  presentation: unknown;
} | null {
  if (!workflowId) {
    return null;
  }
  if (workspaceView !== "draft" && presentation === null) {
    return null;
  }
  return {
    workflowId,
    workspaceView,
    presentation,
  };
}

/** Fit the full canvas after React Flow has installed a complete graph update. */
export function useFitWorkflowGraph(input: {
  update: WorkflowGraphUpdate | null;
  workflowId: string | null;
  beforeFit: () => void;
  fitView: () => Promise<boolean>;
}): void {
  const handledRevisionRef = useRef(input.update?.revision ?? 0);

  useAfterPaint(input.update?.revision ?? 0, () => {
    const update = input.update;
    if (!update || update.revision <= handledRevisionRef.current) {
      return;
    }
    handledRevisionRef.current = update.revision;
    if (update.workflowId !== input.workflowId) {
      return;
    }
    input.beforeFit();
    void input.fitView();
  });
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
    canvasHeight: number;
    graphBounds: { x: number; y: number; width: number; height: number };
    nodePosition: { x: number; y: number };
    nodeWidth: number;
    fittedViewport: { x: number; y: number; zoom: number };
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
    const viewport = initialWorkflowViewport({
      canvas: { width: anchor.canvasWidth, height: anchor.canvasHeight },
      graphBounds: anchor.graphBounds,
      lifecycle: {
        nodePosition: anchor.nodePosition,
        nodeWidth: anchor.nodeWidth,
        top: 48,
      },
      fittedViewport: anchor.fittedViewport,
    });
    if (viewport !== anchor.fittedViewport) {
      await setViewport(viewport);
    }
  } finally {
    if (isCurrent()) {
      reveal();
    }
  }
}

export function canvasSynchronizationKey({
  workspaceView,
  executionOverlay,
  comparison,
  draftEdges,
}: {
  workspaceView: "draft" | "runs" | "changes";
  executionOverlay: unknown;
  comparison: unknown;
  draftEdges: WorkflowEdge[];
}): unknown {
  if (workspaceView === "runs") {
    return executionOverlay ?? EMPTY_RUN_PRESENTATION;
  }
  if (workspaceView === "changes") {
    return comparison ?? EMPTY_CHANGES_PRESENTATION;
  }
  return draftEdges;
}

export function synchronizeCanvasGraph({
  nodes,
  edges,
  currentNodes,
  currentEdges,
  setNodes,
  setEdges,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  currentNodes: WorkflowNode[];
  currentEdges: WorkflowEdge[];
  setNodes: (nodes: WorkflowNode[]) => void;
  setEdges: (edges: WorkflowEdge[]) => void;
}): void {
  if (currentNodes !== nodes) {
    setNodes(nodes);
  }
  if (currentEdges !== edges) {
    setEdges(edges);
  }
}
