import { atom } from "jotai";
import {
  executionOverlayGraphAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

const workspaceTransitionEpochStateAtom = atom(0);

/** Starts a workspace transition and returns its authority token. */
export const beginWorkspaceTransitionAtom = atom(null, (get, set) => {
  const epoch = get(workspaceTransitionEpochStateAtom) + 1;
  set(workspaceTransitionEpochStateAtom, epoch);
  return epoch;
});

/** Read-only epoch used to reject an async transition that lost authority. */
export const workspaceTransitionEpochAtom = atom((get) =>
  get(workspaceTransitionEpochStateAtom)
);

/** Enter the editable draft while retaining the last comparison for refresh. */
export const enterDraftWorkspaceAtom = atom(null, (get, set) => {
  set(beginWorkspaceTransitionAtom);
  set(selectedExecutionIdAtom, null);
  set(executionOverlayGraphAtom, null);
  const selectedNodeId = get(selectedNodeAtom);
  if (
    selectedNodeId &&
    !get(nodesAtom).some((node) => node.id === selectedNodeId)
  ) {
    set(selectedNodeAtom, null);
  }
  set(selectedEdgeAtom, null);
  set(workflowWorkspaceViewAtom, "draft");
});

/** Enter run inspection while retaining the last comparison for refresh. */
export const enterRunsWorkspaceAtom = atom(null, (_get, set) => {
  set(beginWorkspaceTransitionAtom);
  set(workflowWorkspaceViewAtom, "runs");
});

/** Enter publication comparison after removing any selected run presentation. */
export const enterChangesWorkspaceAtom = atom(null, (_get, set) => {
  set(beginWorkspaceTransitionAtom);
  set(selectedExecutionIdAtom, null);
  set(executionOverlayGraphAtom, null);
  set(workflowWorkspaceViewAtom, "changes");
});
