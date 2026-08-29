/**
 * What this hook adds to the write it wraps: live-ward asks first, and asks in
 * the words of the version the mode governs. Test-ward stays one press, because
 * it can only narrow who a run reaches.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useSetPublishedMode } from "#src/hooks/use-set-published-mode";
import { orpcQuery } from "#src/lib/rpc-query";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";

const WORKFLOW_ID = "workflow_1";

/** The one control under test: a press that asks for a mode. */
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
  publishedVersion?: number;
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
  // The confirmation names the published version, which the hook reads off the
  // same cache entry the status strip's badge does.
  queryClient.setQueryData(
    orpcQuery.workflow.getById.queryKey({ input: { workflowId: WORKFLOW_ID } }),
    {
      ...savedWorkflow(WORKFLOW_ID),
      ...(options.publishedVersion === undefined
        ? {}
        : {
            publishedVersionId: `version_${options.publishedVersion}`,
            publishedVersion: options.publishedVersion,
          }),
    }
  );

  return {
    update,
    ...render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <OverlayProvider>
            <ModeProbe mode={options.ask} />
            <OverlayContainer />
          </OverlayProvider>
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
    const { getByRole, queryByRole, update } = renderProbe({
      ask: "test",
      currentMode: "live",
    });

    fireEvent.click(getByRole("button", { name: "Ask for test" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(WORKFLOW_ID, { mode: "test" });
    });
    expect(queryByRole("button", { name: "Send real messages" })).toBeNull();
  });

  it("asks before a workflow starts sending to real people", async () => {
    const { findByText, getByRole, update } = renderProbe({
      ask: "live",
      publishedVersion: 5,
    });

    fireEvent.click(getByRole("button", { name: "Ask for live" }));

    expect(
      await findByText("Send real messages from Appointment reminders?")
    ).toBeTruthy();
    expect(
      await findByText(
        "Events and manual runs of Published v5 will reach real recipients."
      )
    ).toBeTruthy();
    // Nothing is written by the asking itself.
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Send real messages" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(WORKFLOW_ID, { mode: "live" });
    });
  });

  // Nothing is published yet, so the confirmation names the setting's subject
  // rather than a version number nobody could run.
  it("names no version before the first publish", async () => {
    const { findByText, getByRole } = renderProbe({ ask: "live" });

    fireEvent.click(getByRole("button", { name: "Ask for live" }));

    expect(
      await findByText(
        "Events and manual runs of the published version will reach real recipients."
      )
    ).toBeTruthy();
  });

  it("writes nothing when the workflow is already in the mode asked for", async () => {
    const { getByRole, queryByRole, update } = renderProbe({
      ask: "live",
      currentMode: "live",
    });

    fireEvent.click(getByRole("button", { name: "Ask for live" }));

    expect(queryByRole("button", { name: "Send real messages" })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
