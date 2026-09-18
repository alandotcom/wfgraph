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
import { useCallback } from "react";
import { generateId } from "@wfgraph/shared/utils/id";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { CanvasPosition } from "#src/lib/command-palette";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { isConditionActionNode } from "@wfgraph/shared/conditions/condition-branch";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import { repairNodeIntegration } from "#src/lib/node-integration";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  addNodeAtom,
  addStepAfterAtom,
  canvasEdgesAtom,
  canvasNodesAtom,
  insertStepOnEdgeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  positionClearOfNodes,
  workflowNodeRectangles,
} from "#src/lib/workflow-node-placement";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";

export type AddStepRequest = {
  /** The action the step runs. Absent leaves the node asking for one. */
  actionType?: string | undefined;
  /** Where the user pointed. Absent puts the step in the middle of the canvas. */
  at?: CanvasPosition | undefined;
};

/**
 * Returns a function that creates a step, selects it, and opens its
 * configuration. On a focused Group canvas the step becomes a member of that
 * Group, which places it from the Group's layout. Does nothing when React Flow
 * is not on screen to measure, and shows the refusal when the Group rules
 * refuse the step.
 */
export function useAddStep(): (request: AddStepRequest) => void {
  const store = useStore();
  const newStep = useNewStep();
  const addNode = useSetAtom(addNodeAtom);
  const addStepAfter = useSetAtom(addStepAfterAtom);
  const catalog = useExtensionCatalog();
  const { getInternalNode, screenToFlowPosition } = useReactFlow();

  return useCallback(
    ({ actionType, at }: AddStepRequest) => {
      const selected = selectedStepOutlet(store);
      const position =
        at ??
        (selected
          ? positionAfter(store, selected.nodeId)
          : // The painted canvas of the active scope. On the overview a Group
            // is its collapsed card and its members take no room.
            canvasCentre(
              store.get(canvasNodesAtom),
              screenToFlowPosition,
              (nodeId) => getInternalNode(nodeId)?.internals.positionAbsolute
            ));
      if (!position) {
        return;
      }
      const node = newStep({ actionType, position });
      // A step added while one step is selected goes on that step's outlet,
      // the way Add step after does; with no selection it stands alone.
      showGraphEditRefusal(
        selected && at === undefined
          ? addStepAfter({ node, source: selected, catalog })
          : addNode(node)
      );
    },
    [
      addNode,
      addStepAfter,
      catalog,
      getInternalNode,
      newStep,
      screenToFlowPosition,
      store,
    ]
  );
}

/**
 * Returns a function that adds a step on one outlet of a step already on the
 * canvas and opens its configuration: the new step runs beside whatever that
 * outlet already reaches and rejoins the same next steps.
 */
export function useAddStepAfter(): (input: {
  source: { nodeId: string; handle: string | null };
}) => void {
  const store = useStore();
  const newStep = useNewStep();
  const addStepAfter = useSetAtom(addStepAfterAtom);
  const catalog = useExtensionCatalog();

  return useCallback(
    ({ source }) => {
      const position = positionAfter(store, source.nodeId);
      if (!position) {
        return;
      }
      showGraphEditRefusal(
        addStepAfter({ node: newStep({ position }), source, catalog })
      );
    },
    [addStepAfter, catalog, newStep, store]
  );
}

/**
 * Returns a function that puts a step inside one connection and opens its
 * configuration: the connection's source reaches the new step, and the new step
 * reaches what the connection reached.
 */
export function useInsertStepOnEdge(): (input: { edgeId: string }) => void {
  const store = useStore();
  const newStep = useNewStep();
  const insertStep = useSetAtom(insertStepOnEdgeAtom);
  const catalog = useExtensionCatalog();

  return useCallback(
    ({ edgeId }) => {
      const edge = store
        .get(canvasEdgesAtom)
        .find((item) => item.id === edgeId);
      const position = edge ? positionAfter(store, edge.source) : null;
      if (!position) {
        return;
      }
      showGraphEditRefusal(
        insertStep({ node: newStep({ position }), edgeId, catalog })
      );
    },
    [catalog, insertStep, newStep, store]
  );
}

/**
 * The outlet a step added with no place named goes on: the one outlet of the
 * one step the active scope selects. Null with any other selection, and null
 * for a Condition, an Event Split or the Lifecycle Node, which draw several
 * outlets and are asked which one through their menu instead.
 */
function selectedStepOutlet(
  store: ReturnType<typeof useStore>
): { nodeId: string; handle: string | null } | null {
  const selection = store.get(activeSelectionAtom);
  const [nodeId] = selection.nodeIds;
  if (nodeId === undefined || selection.nodeIds.length !== 1) {
    return null;
  }
  const node = store.get(canvasNodesAtom).find((item) => item.id === nodeId);
  const drawsOneOutlet =
    node !== undefined &&
    node.data.type !== "lifecycle" &&
    !isEventSplitNode(node) &&
    !isConditionActionNode(node);
  return drawsOneOutlet ? { nodeId, handle: null } : null;
}

/**
 * Where a step added after the step `sourceId` goes: one rank past it, moved
 * clear of the cards already there. Null when the canvas holds no such step.
 * A focused Group ignores it and places the step from the Group's layout.
 */
function positionAfter(
  store: ReturnType<typeof useStore>,
  sourceId: string
): { x: number; y: number } | null {
  const nodes = store.get(canvasNodesAtom);
  const source = nodes.find((node) => node.id === sourceId);
  if (!source) {
    return null;
  }
  return positionClearOfNodes(
    {
      x: source.position.x,
      y: source.position.y + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    },
    workflowNodeRectangles(nodes, () => undefined)
  );
}

/**
 * Returns a function that builds one step, with the connection binding a
 * plugin step picked from the palette needs.
 */
function useNewStep(): (input: {
  actionType?: string | undefined;
  position: { x: number; y: number };
}) => WorkflowNode {
  const catalog = useExtensionCatalog();
  const queryClient = useQueryClient();
  return useCallback(
    ({ actionType, position }) => {
      const node: WorkflowNode = {
        id: generateId(),
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
      return integrations
        ? repairNodeIntegration(catalog, node, integrations)
        : node;
    },
    [catalog, queryClient]
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
