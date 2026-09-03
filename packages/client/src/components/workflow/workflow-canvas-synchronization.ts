import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

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

export const keyboardFitViewOptions = { padding: 0.2, duration: 0 } as const;

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

export function useSynchronizedCanvas({
  presentation,
  synchronizePresentation,
  currentWorkflowId,
  lifecycleNode,
  internalNode,
  fitGenerationRef,
}: {
  presentation: unknown;
  synchronizePresentation: () => void;
  currentWorkflowId: string | null;
  lifecycleNode: WorkflowNode | null;
  internalNode: InternalLifecycleAnchor | null;
  fitGenerationRef: { current: number };
}): {
  lifecycleAnchor: ReturnType<typeof synchronizedLifecycleAnchor>;
  fitViewKey: string | null;
} {
  useBeforePaint(presentation, synchronizePresentation);

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
  // outgoing graph. Presentation replacements own their viewport separately.
  useBeforePaint(fitViewKey, () => {
    fitGenerationRef.current += 1;
  });

  return { lifecycleAnchor, fitViewKey };
}

/** Fit the full canvas after React Flow has installed an agent graph update. */
export function useFitAgentGraph(input: {
  revision: number;
  beforeFit: () => void;
  fitView: () => Promise<boolean>;
}): void {
  useAfterPaint(input.revision, () => {
    if (input.revision === 0) {
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
