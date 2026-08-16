import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";

/**
 * Close the open run, staying on the Runs tab so the list is what comes back.
 *
 * Which run is open is URL state, and `ExecutionOverlaySync` nulls the selection
 * and the pinned graph from there, which is what releases
 * `canvasEditingLockedAtom`. `replace` rather than a push, so the browser Back
 * button cannot undo the exit and reopen the run just closed (#40).
 */
export function useExitRun(): () => void {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });

  return useCallback(() => {
    void navigate({ search: {}, replace: true });
  }, [navigate]);
}

/**
 * Close the open run and leave the Runs tab, for an interaction that takes the
 * whole panel off screen rather than stepping back inside it: the mobile config
 * sheet closing, or the desktop rail collapsing.
 *
 * Both hide the tab bar without unmounting the tab state, so on their own they
 * left the run pinned to the canvas with every edit refused and nothing on
 * screen saying why (#96). Leaving the tab as well means the surface reopens on
 * Properties, which is the only thing it can usefully show once the run is gone.
 */
export function useLeaveRunsSurface(): () => void {
  const exitRun = useExitRun();
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);

  return useCallback(() => {
    // Written here rather than left to the route's `beforeLoad`, so the canvas
    // is editable in the commit the interaction caused rather than one router
    // pass later.
    setActiveTab("properties");
    exitRun();
  }, [exitRun, setActiveTab]);
}
