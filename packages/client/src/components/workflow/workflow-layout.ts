/** Adds React Flow presentation fields to the shared automatic layout. */

import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { layoutWorkflowNodes as layoutSharedWorkflowNodes } from "@wfgraph/shared/graph/workflow-layout";
import {
  GROUP_BOUNDARY_STUB_PORT,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";

export function layoutWorkflowNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  availableWidth?: number | undefined;
  catalog: ExtensionCatalog;
}): { nodes: WorkflowNode[]; changed: boolean } {
  // Stubs borrow an outside step's data for labels, not its branching shape.
  const result = layoutSharedWorkflowNodes({
    ...input,
    nodes: input.nodes.map((node): WorkflowNode =>
      node.data[GROUP_BOUNDARY_STUB_PORT]
        ? { ...node, data: { type: "action", label: node.data.label } }
        : node
    ),
  });
  const nodes = result.nodes.map((node, index) =>
    input.nodes[index]?.data[GROUP_BOUNDARY_STUB_PORT]
      ? { ...node, data: input.nodes[index].data }
      : isGroupNode(node) &&
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
