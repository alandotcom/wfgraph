/**
 * Which nodes above a Condition offer an output path, in the graph's node
 * order. A rule naming no node reads its path from every finished output folded
 * together in that order, so the last node listed is the one whose value it
 * reads. Validation warns on such a rule when more than one node is listed.
 */

import { type ExtensionCatalog, findAction } from "#src/extensions/catalog";
import { arrivingEventReachability } from "#src/graph/events-reaching";
import { readConfigString } from "#src/graph/node-config";
import { fieldsVisibleForConfig } from "#src/graph/node-references";
import { reachableEventFields } from "#src/graph/reachable-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";

export function nodesOfferingOutputPath(input: {
  targetNodeId: string;
  /** An output path as a node declares it, with no node qualification. */
  path: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): WorkflowNode[] {
  const upstream = upstreamNodeIds(input.targetNodeId, input.edges);

  return input.nodes.filter((node) => {
    if (!upstream.has(node.id)) {
      return false;
    }

    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      const action = findAction(input.catalog, actionType);
      return action
        ? fieldsVisibleForConfig(node.data.config, action.outputFields).some(
            (field) => field.path === input.path
          )
        : false;
    }

    // The entry node's output is the payload of whichever Event put the run at
    // the target, so it offers what those Events declare there.
    if (node.data.type === "lifecycle") {
      const { events } = arrivingEventReachability(input);
      return reachableEventFields(events).some(
        (field) => field.path === input.path
      );
    }

    return false;
  });
}
