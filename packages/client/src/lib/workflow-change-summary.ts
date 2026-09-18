/**
 * The counts a comparison of a published version with the draft reads as,
 * under Behavior and Organization. Changes Browse and the Publish confirmation
 * both show them, so a version reads the same on each surface.
 */

import { countBy, partition } from "es-toolkit/array";
import {
  classifyWorkflowComparison,
  type NodeChangeCategories,
} from "@wfgraph/shared/graph/change-classification";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";

/** The parts of a comparison its summary is computed from. */
export type ComparisonChanges = Pick<
  WorkflowComparisonPayload,
  "baseGraph" | "draftGraph" | "nodeChanges" | "edgeChanges"
>;

/**
 * How many changes of each kind a list holds, as "1 added, 2 removed", or
 * "No changes" for none.
 */
export function describeChangeCounts(
  changes: ReadonlyArray<{ kind: "added" | "modified" | "removed" }>
): string {
  const counts = countBy(changes, (change) => change.kind);
  const parts = (["added", "modified", "removed"] as const).flatMap((kind) =>
    counts[kind] ? [`${counts[kind]} ${kind}`] : []
  );
  return parts.length === 0 ? "No changes" : parts.join(", ");
}

/** The sentence that says an Organization-only comparison runs as before. */
export const ORGANIZATION_ONLY_STATEMENT =
  "Execution behavior is unchanged. Only how steps are organized in Groups differs.";

/**
 * The rows of a comparison's summary. `behavior` counts the steps whose
 * behavior changed and the changed connections, and is null for a comparison
 * whose only changes are Group organization. `organization` counts the changed
 * Group frames and the steps whose Group membership changed, and is null when
 * no Group organization changed.
 */
export type ComparisonSummary = {
  behavior: { steps: string; connections: string } | null;
  organization: { groups: string; membership: string } | null;
};

/** The summary of `changes`, classified by `classifyWorkflowComparison`. */
export function comparisonSummary(
  changes: ComparisonChanges
): ComparisonSummary {
  const categories = classifyWorkflowComparison(changes);
  const [groupChanges, stepChanges] = partition(changes.nodeChanges, (change) =>
    categories.groupFrameIds.has(change.nodeId)
  );
  const touches = (
    nodeId: string,
    category: keyof NodeChangeCategories
  ): boolean => categories.nodes.get(nodeId)?.[category] === true;
  const moved = stepChanges.filter((change) =>
    touches(change.nodeId, "organization")
  ).length;
  return {
    behavior:
      categories.organization && !categories.behavior
        ? null
        : {
            steps: describeChangeCounts(
              stepChanges.filter((change) => touches(change.nodeId, "behavior"))
            ),
            connections: describeChangeCounts(changes.edgeChanges),
          },
    organization: categories.organization
      ? {
          groups: describeChangeCounts(groupChanges),
          membership:
            moved === 0
              ? "No changes"
              : `${moved} ${moved === 1 ? "step" : "steps"} changed`,
        }
      : null,
  };
}
