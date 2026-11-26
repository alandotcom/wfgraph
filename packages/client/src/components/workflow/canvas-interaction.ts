/**
 * What the workflow canvas lets a person do below and above `md`. Every surface
 * that changes which steps exist, how they connect, how they are grouped, or
 * where they sit reads `useTopologyAuthoring`, directly or through
 * `useTopologyCapabilities` or `useCanvasInteraction`.
 */

import { useAtomValue, useAtomValueRawSync } from "jotai";
import { useCallback } from "react";
import { useIsMobile } from "#src/hooks/use-mobile";
import { can } from "#src/lib/authorization";
import { canUngroup } from "#src/lib/node-group";
import { isExecutionOverlayActiveAtom } from "#src/lib/workflow-graph-presentation-store";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { reviewDisplayGraphAtom } from "#src/lib/workflow-review-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/**
 * Whether this form factor offers topology authoring: moving, adding and
 * deleting steps, drawing and reconnecting connections, grouping, ungrouping,
 * multi-select, paste, duplicate and Tidy layout.
 * A phone inspects the workflow and configures existing steps, so the answer
 * is false below `md`. The build agent is not governed by it.
 */
export function useTopologyAuthoring(): boolean {
  return !useIsMobile();
}

/**
 * The topology edits an inspector body offers for the person's grants on this
 * form factor, so a body reads a capability and never the viewport width.
 */
export type TopologyCapabilities = {
  /** Whether a step, a connection, or a selection offers Delete. */
  canDelete: boolean;
  /** Whether `node` offers Ungroup: a Group frame or a Group member. */
  canUngroup: (node: WorkflowNode | undefined) => boolean;
};

export function useTopologyCapabilities(): TopologyCapabilities {
  const topologyAuthoring = useTopologyAuthoring();
  const canDelete =
    topologyAuthoring && can(WfGraphOperations.workflowUpdate.id);
  const canUngroupNode = useCallback(
    (node: WorkflowNode | undefined) => canDelete && canUngroup(node),
    [canDelete]
  );
  return {
    canDelete,
    canUngroup: canUngroupNode,
  };
}

export type CanvasInteraction = ReturnType<typeof canvasInteractionState>;

export function canvasInteractionState({
  editingLocked,
  comparisonActive,
  overlayActive,
  topologyAuthoring,
}: {
  editingLocked: boolean;
  comparisonActive: boolean;
  overlayActive: boolean;
  /** `useTopologyAuthoring`: false on a phone. */
  topologyAuthoring: boolean;
}) {
  const comparisonVisible = comparisonActive && !overlayActive;
  const editsTopology = !editingLocked && topologyAuthoring;
  return {
    /**
     * Whether the Draft accepts edits at all: settings, moves and history.
     * False while anything but the editable Draft owns the canvas, or for a
     * person without the `workflowUpdate` grant.
     */
    editsDraft: !editingLocked,
    comparisonVisible,
    /**
     * Whether adding, pasting, and duplicating steps is offered. On a focused
     * Group canvas an inserted step joins that Group.
     */
    insertsNodes: editsTopology && !comparisonVisible,
    /** Whether the context menus, delete keys, and connections are offered. */
    editsTopology: editsTopology && !comparisonVisible,
    elementsSelectable: !editingLocked || comparisonVisible,
    nodesDraggable: topologyAuthoring && (!editingLocked || comparisonVisible),
    edgesFocusable: !comparisonVisible,
    deleteKeyCode:
      comparisonVisible || !topologyAuthoring ? null : ["Backspace", "Delete"],
    /** The keys that add to a selection, null where multi-select is off. */
    multiSelectionKeyCode: topologyAuthoring
      ? ["Meta", "Control", "Shift"]
      : null,
    /** The key that drags a selection box, null where multi-select is off. */
    selectionKeyCode: topologyAuthoring ? "Shift" : null,
  };
}

/**
 * What the canvas lets this person do now: `canvasInteractionState` for their
 * `workflowUpdate` grant, the editing lock (a run, the review sheet, a running
 * agent turn), the review sheet's comparison, the open run and the form
 * factor. The canvas, its context menu, the outline's row gestures and the
 * step menus all read this one answer, so none of them can offer a command
 * the canvas refuses.
 */
export function useCanvasInteraction(): CanvasInteraction {
  const topologyAuthoring = useTopologyAuthoring();
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  // The overlay synchronizer can write this before subscriptions mount.
  const overlayActive = useAtomValueRawSync(isExecutionOverlayActiveAtom);
  const comparisonActive = useAtomValue(reviewDisplayGraphAtom) !== null;
  return canvasInteractionState({
    editingLocked: editingLocked || !can(WfGraphOperations.workflowUpdate.id),
    comparisonActive,
    overlayActive,
    topologyAuthoring,
  });
}
