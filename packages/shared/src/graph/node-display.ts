/**
 * What a node is called on screen and inside a template token.
 *
 * A token is `{{@nodeId:Label.path}}`, and the engine resolves it by the id
 * alone, so the label is display. It still has to agree everywhere it is
 * written: the editor's reference picker, the rename that rewrites tokens in
 * other nodes, and the build agent listing what a node can address. One rule
 * here is what keeps those three from drifting.
 */

import { type ExtensionCatalog, findAction } from "#src/extensions/catalog";
import { readConfigString } from "#src/graph/node-config";
import type { WorkflowNode } from "#src/graph/types";

export function getNodeDisplayName(
  catalog: ExtensionCatalog,
  node: WorkflowNode
): string {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      const action = findAction(catalog, actionType);
      if (action?.label) {
        return action.label;
      }
    }

    return actionType || "Action";
  }

  if (node.data.type === "lifecycle") {
    return "Lifecycle";
  }

  return "Node";
}
