import { useAtomValue, useStore } from "jotai";
import { useRef } from "react";
import { useOpenRunIdentity } from "#src/components/workflow/use-workflow-runs";
import { useAfterCommit } from "#src/hooks/effects";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  inspectRunNodeAtom,
} from "#src/lib/workflow-workspace-navigation";

/**
 * Opens a failed or waiting run on the step it stopped at. The editor mounts
 * it once, so it answers whether or not the outline floating over the canvas
 * shows. It reads the open run only in Runs, so Draft asks for no run.
 */
export function RunStoppedStepSelection() {
  const view = useAtomValue(workflowWorkspaceViewAtom);
  return view === "runs" ? <OpenRunStoppedStep /> : null;
}

function OpenRunStoppedStep() {
  const identity = useOpenRunIdentity();
  useSelectStoppedStep(identity?.kind === "run" ? identity.execution : null);
  return null;
}

/**
 * Select the step an opening run stopped at, once per run: the step that
 * failed in a failed run, or the Wait a waiting run is parked on, with its
 * evidence in the Inspector. The canvas already places that step in
 * view when the run opens, so this asks for no camera move. A run that has
 * a selection, or that ended any other way, opens as it is.
 */
function useSelectStoppedStep(
  openRun: { id: string; status: string } | null
): void {
  const store = useStore();
  const overlay = useAtomValue(executionOverlayGraphAtom);
  const handledRunId = useRef<string | null>(null);
  const stoppedNodeId = overlay?.stoppedNodeId ?? null;
  const key =
    openRun === null || overlay === null
      ? null
      : `${openRun.id}|${openRun.status}|${stoppedNodeId ?? ""}`;
  useAfterCommit(key, () => {
    if (openRun === null || overlay === null) return;
    if (handledRunId.current === openRun.id) return;
    if (openRun.status !== "failed" && openRun.status !== "waiting") {
      // A run still running may yet stop; one that ended never will.
      if (openRun.status !== "running") {
        handledRunId.current = openRun.id;
      }
      return;
    }
    if (stoppedNodeId === null) return;
    handledRunId.current = openRun.id;
    if (store.get(activeSelectionAtom).nodeIds.length > 0) return;
    store.set(inspectRunNodeAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      nodeId: stoppedNodeId,
      executionLogId: null,
      selectsNode: true,
      opensFocus: true,
    });
  });
}
