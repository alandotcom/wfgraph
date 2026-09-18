/**
 * What the workflow canvas lets a person do, and the one flag that turns off
 * topology authoring below `md`. Every surface that changes which steps exist,
 * how they connect, how they are grouped, or where they sit reads that flag,
 * directly or through `useTopologyCapabilities`.
 */

import { useCallback } from "react";
import { useIsMobile } from "#src/hooks/use-mobile";
import { can } from "#src/lib/authorization";
import { canUngroup } from "#src/lib/node-group";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/**
 * Whether this form factor offers topology authoring: moving, adding and
 * deleting steps, drawing and reconnecting connections, grouping, ungrouping,
 * changing a Group's direction, multi-select, paste, duplicate and Tidy layout.
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
  /**
   * Whether a Group's layout direction shows as a choice. Without it the
   * direction is only named. The choice is disabled without the update grant.
   */
  offersGroupDirectionChoice: boolean;
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
    offersGroupDirectionChoice: topologyAuthoring,
  };
}

export function canvasInteractionState({
  editingLocked,
  comparisonActive,
  overlayActive,
  groupScopeActive,
  topologyAuthoring,
}: {
  editingLocked: boolean;
  comparisonActive: boolean;
  overlayActive: boolean;
  /** A focused Group canvas, which inserts no node until it can edit topology. */
  groupScopeActive: boolean;
  /** `useTopologyAuthoring`: false on a phone. */
  topologyAuthoring: boolean;
}) {
  const comparisonVisible = comparisonActive && !overlayActive;
  const editsTopology = !editingLocked && topologyAuthoring;
  return {
    comparisonVisible,
    /** Whether adding, pasting, and duplicating steps is offered. */
    insertsNodes: editsTopology && !comparisonVisible && !groupScopeActive,
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
