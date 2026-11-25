/**
 * Adding a step to the graph, from wherever the request came in.
 *
 * One home for the two decisions a new step needs -- where it goes, and what a
 * just-chosen action leaves on its config -- so the toolbar, the canvas's
 * context menu and the command palette cannot answer either of them
 * differently. Open-canvas placement is `positionClearOfNodes` against
 * `canvasObstacles`; inserting on a connection opens its row inside
 * `insertStepOnEdgeAtom`. The config rule is `repairNodeIntegration`, which
 * `use-node-config-writer.ts` runs for the same reason when an action is
 * chosen on a node that already exists.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { generateId } from "@wfgraph/shared/utils/id";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import type { CanvasPosition, StepOutlet } from "#src/lib/command-palette";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { isConditionActionNode } from "@wfgraph/shared/conditions/condition-branch";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { repairNodeIntegration } from "#src/lib/node-integration";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  addNodeAtom,
  addStepAfterAtom,
  canvasEdgesAtom,
  canvasNodesAtom,
  canvasPlacementNodesAtom,
  edgesAtom,
  insertStepOnEdgeAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  canvasObstacles,
  positionClearOfNodes,
} from "#src/lib/workflow-node-placement";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { soleStartedPathEnd } from "#src/components/workflow/connection-handle";

export type AddStepRequest = {
  /** The action the step runs. Absent leaves the node asking for one. */
  actionType?: string | undefined;
  /** Where the user pointed. Absent puts the step in the middle of the canvas. */
  at?: CanvasPosition | undefined;
  /** The open outlet the step joins, which takes the selection's place. */
  after?: StepOutlet | undefined;
};

/**
 * Returns a function that creates a step, selects it, and opens its
 * configuration. With one step selected the step goes on that step's outlet.
 * With nothing selected, a Started path with one open end gains the step
 * there. Otherwise it stands alone in clear canvas. A step added after a
 * member joins that member's Group, and a step placed inside a Group's region
 * joins that Group. Does nothing when React Flow is not on screen to measure,
 * and shows the refusal when the Group rules refuse the step.
 */
export function useAddStep(): (request: AddStepRequest) => void {
  const store = useStore();
  const newStep = useNewStep();
  const addNode = useSetAtom(addNodeAtom);
  const addStepAfter = useSetAtom(addStepAfterAtom);
  const catalog = useExtensionCatalog();
  const { screenToFlowPosition } = useReactFlow();

  return useCallback(
    ({ actionType, at, after }: AddStepRequest) => {
      const source =
        after ?? (at === undefined ? outletForNewStep(store, catalog) : null);
      const position =
        at ??
        (source
          ? positionAfter(store, source.nodeId)
          : // The painted canvas, each member at its canvas position.
            canvasCentre(
              store.get(canvasPlacementNodesAtom),
              store.get(canvasEdgesAtom),
              screenToFlowPosition
            ));
      if (!position) {
        return;
      }
      const node = newStep({ actionType, position });
      // A step with an outlet to go on joins it the way Add step after does,
      // in the same undo step.
      showGraphEditRefusal(
        source ? addStepAfter({ node, source, catalog }) : addNode(node)
      );
    },
    [addNode, addStepAfter, catalog, newStep, screenToFlowPosition, store]
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
 * The outlet a step added with no place named goes on. With a selection it is
 * `selectedStepOutlet`. With nothing selected it is the
 * Started path's one open end, such as the Lifecycle Node's Started outlet in
 * a new workflow. Null otherwise, and the step stands alone.
 */
function outletForNewStep(
  store: ReturnType<typeof useStore>,
  catalog: ExtensionCatalog
): { nodeId: string; handle: string | null } | null {
  if (store.get(activeSelectionAtom).nodeIds.length > 0) {
    return selectedStepOutlet(store);
  }
  return soleStartedPathEnd({
    nodes: store.get(nodesAtom),
    edges: store.get(edgesAtom),
    catalog,
  });
}

/**
 * The outlet of the one step the active scope selects: its only outlet, or
 * Started for the Lifecycle Node, which is where a workflow's path begins.
 * Null with any other selection, and null for a Condition or an Event Split,
 * whose branches are equal and are asked for through their menu instead.
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
  if (
    node === undefined ||
    isEventSplitNode(node) ||
    isConditionActionNode(node)
  ) {
    return null;
  }
  return {
    nodeId,
    handle: node.data.type === "lifecycle" ? LIFECYCLE_STARTED_HANDLE : null,
  };
}

/**
 * Where a step added after the step `sourceId` goes, as a canvas point: one
 * rank past it, moved clear of the cards and connections already there. Null
 * when the canvas holds no such step.
 */
function positionAfter(
  store: ReturnType<typeof useStore>,
  sourceId: string
): { x: number; y: number } | null {
  const nodes = store.get(canvasPlacementNodesAtom);
  const source = nodes.find((node) => node.id === sourceId);
  if (!source) {
    return null;
  }
  return positionClearOfNodes(
    {
      x: source.position.x,
      y: source.position.y + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    },
    canvasObstacles({ nodes, edges: store.get(canvasEdgesAtom) })
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
 * The middle of the visible graph, moved clear of the cards and connections
 * already there.
 *
 * Null when no canvas is mounted, which is the one case where there is nothing
 * to measure against and no sensible place to put a node.
 */
function canvasCentre(
  nodes: readonly WorkflowNode[],
  edges: readonly { source: string; target: string }[],
  screenToFlowPosition: (point: { x: number; y: number }) => {
    x: number;
    y: number;
  }
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
    canvasObstacles({ nodes, edges })
  );
}
