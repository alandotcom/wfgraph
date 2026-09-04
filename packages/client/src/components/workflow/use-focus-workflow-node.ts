import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { viewportAnimationDuration } from "#src/lib/motion";
import {
  displayNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { useWorkflowNodeInspection } from "./use-workflow-node-inspection";

type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Returns a node's canvas bounds when it has an unmeasured parent. Group members
 * use positions relative to their Group frame, so their ancestors contribute to
 * the final position.
 */
export function workflowNodeBounds(
  nodes: readonly WorkflowNode[],
  node: WorkflowNode
): Bounds {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return {
    x,
    y,
    width:
      node.measured?.width ??
      node.width ??
      node.initialWidth ??
      WORKFLOW_NODE_WIDTH,
    height:
      node.measured?.height ??
      node.height ??
      node.initialHeight ??
      WORKFLOW_NODE_HEIGHT,
  };
}

/** Focus a displayed node at a readable scale without changing persistable graph data. */
export function useFocusWorkflowNode(): (input: {
  nodeId: string;
  workflowId: string;
}) => boolean {
  const nodes = useAtomValue(displayNodesAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const inspectNode = useWorkflowNodeInspection();
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const { getViewport, setCenter } = useReactFlow<WorkflowNode, WorkflowEdge>();
  const store = useStoreApi<WorkflowNode, WorkflowEdge>();
  return useCallback(
    (input) => {
      if (workflowId !== input.workflowId) {
        return false;
      }
      const node = nodes.find((item) => item.id === input.nodeId);
      if (!node) {
        return false;
      }

      const internal = store.getState().nodeLookup.get(node.id);
      const fallback = workflowNodeBounds(nodes, node);
      const position = internal?.internals.positionAbsolute ?? fallback;
      const width = internal?.measured?.width ?? fallback.width;
      const height = internal?.measured?.height ?? fallback.height;
      const zoom = Math.max(getViewport().zoom, 1);

      selectOnlyNode(node.id);
      inspectNode(node.id);
      void setCenter(position.x + width / 2, position.y + height / 2, {
        duration: viewportAnimationDuration(),
        zoom,
      });
      return true;
    },
    [
      getViewport,
      inspectNode,
      nodes,
      selectOnlyNode,
      setCenter,
      store,
      workflowId,
    ]
  );
}
