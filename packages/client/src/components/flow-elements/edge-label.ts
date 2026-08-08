/**
 * The label drawn on an edge, if any.
 *
 * Condition outlets take their True/False wording from the handle; every other
 * edge may carry a `displayLabel` the graph put on it. Kept pure so the wording
 * can be tested without standing up @xyflow/react.
 */

import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";

export function resolveEdgeLabel(
  sourceHandleId: string | null | undefined,
  data: { displayLabel?: string } | undefined
): string | null {
  return getConditionBranchDisplayLabel(sourceHandleId) ?? data?.displayLabel ?? null;
}

/** Display atoms mute an inactive Canceled subtree by setting style.opacity. */
export function isMutedEdgeStyle(
  style: { opacity?: number | string } | undefined
): boolean {
  return style?.opacity !== undefined;
}
