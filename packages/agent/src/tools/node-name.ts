/**
 * How a tool result names a node: its canvas label, which is what a person
 * reads, with the id a later tool call needs beside it.
 */

import type { WorkflowNode } from "@wfgraph/shared/graph/types";

/** `"Label" (id)`, or the id alone for a node with no label. */
export function nodeName(node: WorkflowNode): string {
  const label = node.data.label.trim();
  return label === "" ? node.id : `"${label}" (${node.id})`;
}
