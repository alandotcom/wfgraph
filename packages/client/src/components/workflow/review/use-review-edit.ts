import { useAtomValue } from "jotai";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  editOfNode,
  type WorkflowEdit,
  workflowEdits,
} from "#src/lib/workflow-edits";
import {
  isReviewSheetShownAtom,
  reviewComparisonAtom,
} from "#src/lib/workflow-review-store";

/**
 * The edit the review sheet lists for the step `nodeId`, which its card shows
 * as a marker and the same one-line statement. Null while the sheet is closed
 * and for a step with no edit.
 */
export function useReviewEdit(nodeId: string): WorkflowEdit | null {
  const shown = useAtomValue(isReviewSheetShownAtom);
  const payload = useAtomValue(reviewComparisonAtom);
  const catalog = useExtensionCatalog();
  if (!shown || payload === null) return null;
  return editOfNode(workflowEdits(payload, catalog), nodeId) ?? null;
}
