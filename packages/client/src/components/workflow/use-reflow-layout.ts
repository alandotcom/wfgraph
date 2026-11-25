/**
 * The graph's tidy-up pass, shared by the canvas control at bottom left and the
 * Actions menu's "Tidy layout" so the two cannot drift into different rules.
 * Each Group's members are laid out first, inside the region they fill, and
 * the whole graph then around each region. A Group the viewer collapsed keeps
 * its region's room, since collapsing changes nothing stored. Phones offer no
 * topology authoring.
 */

import { useReactFlow } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import {
  applyNodeLayoutAtom,
  canvasEditingLockedAtom,
  edgesAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { viewportAnimationDuration } from "#src/lib/motion";
import { workflowFitViewOptions } from "./workflow-viewport";
import { useTopologyAuthoring } from "./canvas-interaction";

/**
 * The width the layout spaces nodes inside: the graph's own box rather than the
 * window, which is wider than the graph whenever the config panel is open.
 * React Flow's root element carries this class, and it is the same box the
 * canvas measured when the pass lived there.
 */
function graphWidth(): number | undefined {
  const measured = document
    .querySelector(".react-flow")
    ?.getBoundingClientRect().width;
  // A zero is a box that has not been laid out yet, not a narrow one, and
  // `getLayoutSpacing` reads a zero as its narrowest branch. The window is the
  // wrong answer by however much the config panel takes, and a far better wrong
  // answer than packing the graph as though it were on a phone.
  if (measured) {
    return measured;
  }
  return typeof window === "undefined" ? undefined : window.innerWidth;
}

export function useReflowLayout(): {
  canReflow: boolean;
  reflow: () => void;
} {
  const layoutNodes = useAtomValue(nodesAtom);
  const layoutEdges = useAtomValue(edgesAtom);
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const topologyAuthoring = useTopologyAuthoring();
  const applyNodeLayout = useSetAtom(applyNodeLayoutAtom);
  const catalog = useExtensionCatalog();
  const { fitView } = useReactFlow();

  // One node has nothing to be arranged against, and the placeholder `add` node
  // is not one of them.
  const canReflow =
    !editingLocked &&
    topologyAuthoring &&
    layoutNodes.filter((node) => node.type !== "add").length > 1;

  const reflow = useCallback(() => {
    if (!canReflow) {
      return;
    }

    // The pass is synchronous from here to `applyNodeLayout`, so a second click
    // cannot land inside it and there is no in-flight flag to keep.
    const { nodes: laidOutNodes, changed } = layoutWorkflowNodes({
      nodes: layoutNodes,
      edges: layoutEdges,
      availableWidth: graphWidth(),
      catalog,
    });

    if (changed) {
      applyNodeLayout(laidOutNodes);
    }

    // Next frame, because React Flow measures the moved nodes on the paint this
    // one schedules and `fitView` is fitting around those measurements.
    window.requestAnimationFrame(() => {
      Promise.resolve(
        fitView({
          ...workflowFitViewOptions(viewportAnimationDuration()),
        })
      ).catch(() => undefined);
    });
  }, [applyNodeLayout, canReflow, catalog, layoutEdges, fitView, layoutNodes]);

  return { canReflow, reflow };
}
