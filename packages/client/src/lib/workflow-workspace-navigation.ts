import { atom } from "jotai";
import {
  executionOverlayGraphAtom,
  exitWorkflowComparisonAtom,
} from "#src/lib/workflow-graph-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

/** Enter the editable draft and discard every read-only presentation session. */
export const enterDraftWorkspaceAtom = atom(null, (_get, set) => {
  set(selectedExecutionIdAtom, null);
  set(executionOverlayGraphAtom, null);
  set(exitWorkflowComparisonAtom);
  set(workflowWorkspaceViewAtom, "draft");
});

/** Enter run inspection after removing any stale comparison session. */
export const enterRunsWorkspaceAtom = atom(null, (_get, set) => {
  set(exitWorkflowComparisonAtom);
  set(workflowWorkspaceViewAtom, "runs");
});

/** Enter publication comparison after removing any selected run presentation. */
export const enterChangesWorkspaceAtom = atom(null, (_get, set) => {
  set(selectedExecutionIdAtom, null);
  set(executionOverlayGraphAtom, null);
  set(exitWorkflowComparisonAtom);
  set(workflowWorkspaceViewAtom, "changes");
});
