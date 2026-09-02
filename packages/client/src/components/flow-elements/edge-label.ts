/**
 * The label drawn on an edge, if any.
 *
 * Condition outlets take their True/False wording from the handle; every other
 * edge may carry a `displayLabel` the graph put on it. Kept pure so the wording
 * can be tested without standing up @xyflow/react.
 */

import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import {
  COMPARISON_EDGE_ANNOTATION,
  comparisonChangeLabel,
  type EditorEdgeData,
} from "#src/lib/workflow-graph-types";

export function resolveEdgeLabel(
  sourceHandleId: string | null | undefined,
  data: { displayLabel?: string | undefined } | undefined
): string | null {
  return (
    getConditionBranchDisplayLabel(sourceHandleId) ?? data?.displayLabel ?? null
  );
}

/** The complete edge name React Flow exposes to assistive technology. */
export function workflowEdgeAriaLabel({
  sourceLabel,
  targetLabel,
  sourceHandleId,
  data,
}: {
  sourceLabel: string;
  targetLabel: string;
  sourceHandleId: string | null | undefined;
  data: EditorEdgeData | undefined;
}): string {
  const outletLabel = resolveEdgeLabel(sourceHandleId, data);
  const label = outletLabel
    ? `${sourceLabel} to ${targetLabel}, ${outletLabel} branch`
    : `${sourceLabel} to ${targetLabel}`;
  const comparison = data?.[COMPARISON_EDGE_ANNOTATION];
  return comparison
    ? `${label}, ${comparisonChangeLabel(comparison.kind)}`
    : label;
}
