/** Adds React Flow presentation fields to the shared automatic layout. */

import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { layoutWorkflowNodes as layoutSharedWorkflowNodes } from "@wfgraph/shared/graph/workflow-layout";
import { hasLegacyGroupLayout } from "@wfgraph/shared/graph/workflow-layout-geometry";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The shared layout, with each Group frame's `style` sized to the region the
 * layout gave it, the way React Flow reads a parent node's size.
 */
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

/**
 * `graph`, laid out by `layoutWorkflowNodes` when an editor that drew each
 * Group as a collapsed card last laid it out (`hasLegacyGroupLayout`), since
 * that layout reserved a card's room where the Group now draws its whole
 * region. A graph the in-place editor saved comes back unchanged, with
 * `repaired` false.
 */
export function repairLegacyGroupLayout(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): { nodes: WorkflowNode[]; repaired: boolean } {
  if (!hasLegacyGroupLayout(input.nodes)) {
    return { nodes: input.nodes, repaired: false };
  }
  return { nodes: layoutWorkflowNodes(input).nodes, repaired: true };
}
