import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Close the open run, staying in Runs so the list is what comes back.
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
