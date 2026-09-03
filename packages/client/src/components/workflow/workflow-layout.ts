/** Adds React Flow presentation fields to the shared automatic layout. */

import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/node-group";
import { layoutWorkflowNodes as layoutSharedWorkflowNodes } from "@wfgraph/shared/graph/workflow-layout";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export function layoutWorkflowNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  availableWidth?: number | undefined;
  catalog: ExtensionCatalog;
}): { nodes: WorkflowNode[]; changed: boolean } {
  const result = layoutSharedWorkflowNodes(input);
  const nodes = result.nodes.map((node) =>
    isGroupNode(node) &&
    typeof node.width === "number" &&
    typeof node.height === "number"
      ? {
          ...node,
          style: { ...node.style, width: node.width, height: node.height },
        }
      : node
  );

  return { ...result, nodes };
}
