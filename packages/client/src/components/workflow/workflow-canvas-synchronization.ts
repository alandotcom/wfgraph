import { useRef } from "react";
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkspaceKey } from "#src/lib/workflow-navigation-state";
export { lifecycleAnchorViewport } from "./workflow-viewport";

type InternalLifecycleAnchor = {
  userNode: WorkflowNode;
  position: { x: number; y: number };
  width: number | undefined;
};

const EMPTY_RUN_PRESENTATION = {};

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
  remeasureNodes,
  nodeIds,
  currentWorkflowId,
  lifecycleNode,
  internalNode,
}: {
  presentation: unknown;
  synchronizePresentation: () => boolean;
  viewportCorrection: unknown;
  correctViewport: () => void;
  remeasureNodes: (nodeIds: string[]) => void;
  nodeIds: string[];
  currentWorkflowId: string | null;
  lifecycleNode: WorkflowNode | null;
  internalNode: InternalLifecycleAnchor | null;
}): {
  lifecycleAnchor: ReturnType<typeof synchronizedLifecycleAnchor>;
  fitViewKey: string | null;
} {
  const nodesNeedRemeasureRef = useRef(false);
  useBeforePaint(presentation, () => {
    const nodesChanged = synchronizePresentation();
    nodesNeedRemeasureRef.current =
      nodesNeedRemeasureRef.current || nodesChanged;
  });
  useBeforePaint(viewportCorrection, () => {
    if (viewportCorrection !== null) {
      correctViewport();
    }
  });
  // React Flow can retain a mounted node while replacing its internal record.
  // Re-measure after the replacement so retained handles regain their bounds.
  useAfterPaint(presentation, () => {
    if (nodesNeedRemeasureRef.current) {
      nodesNeedRemeasureRef.current = false;
      remeasureNodes(nodeIds);
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
  workspaceView: "draft" | "runs";
  presentation: unknown;
}): {
  workflowId: string;
  workspaceView: "draft" | "runs";
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

/**
 * Whether the canvas stays hidden after placing the Draft it paints in Runs:
 * true while the route names a run whose pinned graph has not arrived. The
 * Draft would otherwise show under the run for the frames the graph takes to
 * load, at its own placement, before the run's graph replaces it. With no run
 * named the run list shows the Draft canvas itself, so it is shown at once.
 */
export function awaitsRunGraph(input: {
  workspaceKey: WorkspaceKey;
  runGraph: unknown;
}): boolean {
  return (
    input.workspaceKey.workspace === "runs" &&
    input.workspaceKey.executionId !== null &&
    input.runGraph === null
  );
}

const pairedPresentations = new WeakMap<object, WeakMap<object, object>>();

/**
 * The key the canvas installs its graph on: the presented run, the comparison
 * the review sheet shows, or the Draft's stored edges, paired with the set of
 * Groups the viewer collapsed. The pair is one object per source and set, so
 * collapsing or expanding a Group installs the next graph and a repaint of
 * either does not.
 */
export function canvasSynchronizationKey({
  workspaceView,
  executionOverlay,
  comparison,
  draftEdges,
  collapsedGroupIds,
}: {
  workspaceView: "draft" | "runs";
  executionOverlay: object | null;
  comparison: object | null;
  draftEdges: WorkflowEdge[];
  collapsedGroupIds: ReadonlySet<string>;
}): object {
  const source =
    workspaceView === "runs"
      ? (executionOverlay ?? EMPTY_RUN_PRESENTATION)
      : (comparison ?? draftEdges);
  const bySet =
    pairedPresentations.get(source) ?? new WeakMap<object, object>();
  pairedPresentations.set(source, bySet);
  const key = bySet.get(collapsedGroupIds) ?? { source, collapsedGroupIds };
  bySet.set(collapsedGroupIds, key);
  return key;
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
}): boolean {
  const nodesChanged = currentNodes !== nodes;
  if (nodesChanged) {
    setNodes(nodes);
  }
  if (currentEdges !== edges) {
    setEdges(edges);
  }
  return nodesChanged;
}
