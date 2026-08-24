/**
 * Adding a step to the graph, from wherever the request came in.
 *
 * One home for the two decisions a new step needs -- where it goes, and what a
 * just-chosen action leaves on its config -- so the toolbar, the canvas's
 * context menu and the command palette cannot answer either of them
 * differently. Placement is `positionClearOfNodes`; the config rule is
 * `repairNodeIntegration`, which `use-node-config-writer.ts` runs for the same
 * reason when an action is chosen on a node that already exists.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useSetAtom, useStore } from "jotai";
import { nanoid } from "nanoid";
import { useCallback } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { CanvasPosition } from "#src/lib/command-palette";
import { repairNodeIntegration } from "#src/lib/node-integration";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  addNodeAtom,
  nodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  positionClearOfNodes,
  workflowNodeRectangles,
} from "#src/lib/workflow-node-placement";

export type AddStepRequest = {
  /** The action the step runs. Absent leaves the node asking for one. */
  actionType?: string;
  /** Where the user pointed. Absent puts the step in the middle of the canvas. */
  at?: CanvasPosition;
};

/**
 * Returns a function that creates a step, selects it, and opens its
 * configuration. Does nothing when React Flow is not on screen to measure.
 */
export function useAddStep(): (request: AddStepRequest) => void {
  const catalog = useExtensionCatalog();
  const queryClient = useQueryClient();
  // The graph is read at the moment a step is added rather than subscribed to,
  // so this hook returns the same function across renders. Subscribed, it put a
  // second `nodesAtom` reader inside the palette and rebuilt its whole item list
  // on any graph change.
  const store = useStore();
  const addNode = useSetAtom(addNodeAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const { getInternalNode, screenToFlowPosition } = useReactFlow();

  return useCallback(
    ({ actionType, at }: AddStepRequest) => {
      const position =
        at ??
        canvasCentre(
          store.get(nodesAtom),
          screenToFlowPosition,
          (nodeId) => getInternalNode(nodeId)?.internals.positionAbsolute
        );
      if (!position) {
        return;
      }

      const node: WorkflowNode = {
        id: nanoid(),
        type: "action",
        position,
        data: {
          label: "",
          description: "",
          type: "action",
          config: actionType ? { actionType } : {},
          status: "idle",
        },
      };

      // A brand-new node has nothing upstream, so there is no condition model
      // to seed here the way the config writer seeds one: `seedConditionModel`
      // reads upstream fields and a node with no incoming edge has none. What
      // does apply is the connection binding, which is how a plugin step picked
      // from the palette arrives already pointing at the one connection of its
      // kind. An entry that has never been fetched is not an empty connection
      // list, so a missing cache entry leaves the node alone.
      const integrations = queryClient.getQueryData(
        integrationsQueryOptions().queryKey
      );
      const bound = integrations
        ? repairNodeIntegration(catalog, node, integrations)
        : node;

      addNode(bound);
      setSelectedNode(bound.id);
    },
    [
      catalog,
      queryClient,
      store,
      addNode,
      setSelectedNode,
      getInternalNode,
      screenToFlowPosition,
    ]
  );
}

/**
 * The middle of the visible graph, moved clear of whatever is already there.
 *
 * Null when no canvas is mounted, which is the one case where there is nothing
 * to measure against and no sensible place to put a node.
 */
function canvasCentre(
  nodes: readonly WorkflowNode[],
  screenToFlowPosition: (point: { x: number; y: number }) => {
    x: number;
    y: number;
  },
  absolutePositionForId: (
    nodeId: string
  ) => { readonly x: number; readonly y: number } | undefined
): { x: number; y: number } | null {
  const pane = document.querySelector(".react-flow");
  if (!pane) {
    return null;
  }

  const rect = pane.getBoundingClientRect();
  // Client coordinates: `screenToFlowPosition` subtracts the pane's own rect.
  const centre = screenToFlowPosition({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });

  return positionClearOfNodes(
    {
      x: centre.x - WORKFLOW_NODE_WIDTH / 2,
      y: centre.y - WORKFLOW_NODE_HEIGHT / 2,
    },
    workflowNodeRectangles(nodes, absolutePositionForId)
  );
}
