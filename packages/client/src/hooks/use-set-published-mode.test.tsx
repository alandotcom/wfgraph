/**
 * Covers what the hook adds to the write it wraps: one press in either
 * direction, a toast naming the mode it landed in, and no write at all when the
 * workflow is already in that mode.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSetPublishedMode } from "#src/hooks/use-set-published-mode";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";

const WORKFLOW_ID = "workflow_1";

/** A button that asks the hook for one mode. */
function ModeProbe({ mode }: { mode: WorkflowMode }) {
  const setPublishedMode = useSetPublishedMode();

  return (
    <button onClick={() => void setPublishedMode(mode)} type="button">
      Ask for {mode}
    </button>
  );
}

function renderProbe(options: {
  ask: WorkflowMode;
  currentMode?: WorkflowMode;
}) {
  const store = createStore();
  const update = vi.fn(async (_workflowId: string, _payload: unknown) => ({
    ...savedWorkflow(WORKFLOW_ID),
    mode: options.ask,
  }));

  store.set(workflowApiAtom, { update: update as never });
  store.set(currentWorkflowIdAtom, WORKFLOW_ID);
  store.set(currentWorkflowModeAtom, options.currentMode ?? "test");
  store.set(currentWorkflowNameAtom, "Appointment reminders");

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    update,
    ...render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <ModeProbe mode={options.ask} />
        </QueryClientProvider>
      </JotaiProvider>
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSetPublishedMode", () => {
  it("sets Test on one press", async () => {
    const success = vi.spyOn(toast, "success");
    const { getByRole, update } = renderProbe({
      ask: "test",
      currentMode: "live",
    });

    fireEvent.click(getByRole("button", { name: "Ask for test" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(WORKFLOW_ID, { mode: "test" }, 0);
    });
    expect(success).toHaveBeenCalledWith("Published mode set to Test");
  });

  // The mode is a setting, and the status strip states it at all times, so
  // turning it on takes the same single press as turning it off.
  it("sets Live on one press", async () => {
    const success = vi.spyOn(toast, "success");
    const { getByRole, update } = renderProbe({ ask: "live" });

    fireEvent.click(getByRole("button", { name: "Ask for live" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(WORKFLOW_ID, { mode: "live" }, 0);
    });
    expect(success).toHaveBeenCalledWith("Published mode set to Live");
  });

  it("writes nothing when the workflow is already in the mode asked for", () => {
    const { getByRole, update } = renderProbe({
      ask: "live",
      currentMode: "live",
    });

    fireEvent.click(getByRole("button", { name: "Ask for live" }));

    expect(update).not.toHaveBeenCalled();
  });
});
