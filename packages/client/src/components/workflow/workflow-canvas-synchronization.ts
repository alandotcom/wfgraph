import { useRef } from "react";
import { useAfterPaint, useBeforePaint } from "#src/hooks/effects";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowGraphUpdate } from "#src/lib/workflow-ui-store";
import { workflowFitViewOptions } from "./workflow-viewport";
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

/** Fit the full canvas after React Flow has installed a complete graph update. */
export function useFitWorkflowGraph(input: {
  update: WorkflowGraphUpdate | null;
  workflowId: string | null;
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
    void input.fitView();
  });
}

const scopedPresentations = new WeakMap<object, Map<string, object>>();

/**
 * The key the canvas installs its graph on: the presented run, the comparison
 * the review sheet shows, or the Draft's stored edges, paired with the
 * `scopeId` of the scope shown. The
 * pair is one object per source and scope, so moving between the overview and a
 * focused Group installs the next graph and a repaint of either does not.
 */
export function canvasSynchronizationKey({
  workspaceView,
  executionOverlay,
  comparison,
  draftEdges,
  scope,
}: {
  workspaceView: "draft" | "runs";
  executionOverlay: object | null;
  comparison: object | null;
  draftEdges: WorkflowEdge[];
  scope: string;
}): object {
  const source =
    workspaceView === "runs"
      ? (executionOverlay ?? EMPTY_RUN_PRESENTATION)
      : (comparison ?? draftEdges);
  const byScope = scopedPresentations.get(source) ?? new Map<string, object>();
  scopedPresentations.set(source, byScope);
  const key = byScope.get(scope) ?? { source, scope };
  byScope.set(scope, key);
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
