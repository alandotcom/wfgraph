/**
 * Selection reads and the selection write for one scope of editor navigation.
 * `workflow-navigation-state` and `mobile-sheet-navigation` both build on these,
 * so they live apart from either. Each write answers its input unchanged when
 * nothing needed to change.
 */

import type {
  CanvasSelection,
  InspectedObject,
  ScopeNavigation,
} from "#src/lib/workflow-navigation-state";

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function sameSelection(
  left: CanvasSelection,
  right: CanvasSelection
): boolean {
  return (
    sameIds(left.nodeIds, right.nodeIds) && sameIds(left.edgeIds, right.edgeIds)
  );
}

/**
 * Write a selection. A chosen run node execution is kept only while the
 * selection holds its node alone, so selecting anything else never shows a
 * stale execution. A selection that no longer holds the inspected object alone
 * ends the jump `inspectedOrigin` recorded, so the origin is cleared.
 */
export function withSelection(
  scope: ScopeNavigation,
  selection: CanvasSelection
): ScopeNavigation {
  if (sameSelection(scope.selection, selection)) {
    return scope;
  }
  const { chosenExecution } = scope;
  const keepsOrigin =
    scope.desktop.inspectedOrigin === null ||
    sameObject(selectedObject(selection), scope.desktop.inspected);
  return {
    ...scope,
    selection,
    desktop: keepsOrigin
      ? scope.desktop
      : { ...scope.desktop, inspectedOrigin: null },
    chosenExecution:
      chosenExecution !== null &&
      singleSelectedNodeId(selection) === chosenExecution.nodeId
        ? chosenExecution
        : null,
  };
}

/** The node id when the selection is exactly one node, otherwise null. */
export function singleSelectedNodeId(
  selection: CanvasSelection
): string | null {
  return selection.nodeIds.length === 1 && selection.edgeIds.length === 0
    ? selection.nodeIds[0]
    : null;
}

/** The edge id when the selection is exactly one edge, otherwise null. */
export function singleSelectedEdgeId(
  selection: CanvasSelection
): string | null {
  return selection.edgeIds.length === 1 && selection.nodeIds.length === 0
    ? selection.edgeIds[0]
    : null;
}

/** The one node or edge a selection holds, or null for none or several. */
export function selectedObject(
  selection: CanvasSelection
): InspectedObject | null {
  const nodeId = singleSelectedNodeId(selection);
  if (nodeId !== null) {
    return { kind: "node", id: nodeId };
  }
  const edgeId = singleSelectedEdgeId(selection);
  return edgeId === null ? null : { kind: "edge", id: edgeId };
}

export function sameObject(
  left: InspectedObject | null,
  right: InspectedObject | null
): boolean {
  return left?.kind === right?.kind && left?.id === right?.id;
}
