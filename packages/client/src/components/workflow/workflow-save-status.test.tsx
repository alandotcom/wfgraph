/**
 * The read-only case, which is the one these two get wrong by default.
 *
 * Nothing on the canvas stops a viewer of a public workflow from dragging a
 * node: `nodesDraggable` is gated on generation and run overlays only, and
 * `requestGraphSave` has no owner check. The save that follows is refused by
 * the server, and the failure path never lowers the dirty flag -- so a viewer
 * who nudges one node would be held on the page by a browser prompt they can
 * never satisfy.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { act } from "react";
import {
  WorkflowHeldSaveRetry,
  WorkflowSaveStatus,
  WorkflowUnloadGuard,
} from "#src/components/workflow/workflow-save-status";
import {
  currentWorkflowIdAtom,
  hasHeldGraphSaveAtom,
  hasUnsavedChangesAtom,
  recordLoadedDraftRevisionAtom,
  saveRetryBackoffAtom,
  saveWorkflowAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { ApiError } from "#src/lib/rpc-client";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

function renderDirty(
  component: React.ReactNode,
  _options: { canUpdate: boolean }
) {
  const store = createStore();
  store.set(hasUnsavedChangesAtom, true);

  const addEventListener = vi.spyOn(window, "addEventListener");

  installAuthorizationGrantsForTests(
    _options.canUpdate ? [WfGraphOperations.workflowUpdate.id] : []
  );

  render(<Provider store={store}>{component}</Provider>);

  return {
    addEventListener,
    armedUnloadGuard: addEventListener.mock.calls.some(
      ([type]) => type === "beforeunload"
    ),
  };
}

afterEach(() => {
  resetAuthorizationGrantsForTests();
  vi.restoreAllMocks();
});

describe("WorkflowSaveStatus", () => {
  it("reports the pending edit for an owner", async () => {
    renderDirty(<WorkflowSaveStatus />, { canUpdate: true });

    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
  });

  it("says nothing for a read-only viewer", async () => {
    renderDirty(<WorkflowSaveStatus />, { canUpdate: false });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("arms no guard of its own, which is the strip's to mount", async () => {
    // The guard used to live here, which meant pinning a run to the canvas
    // unmounted this label and disarmed the guard with it.
    const { armedUnloadGuard } = renderDirty(<WorkflowSaveStatus />, {
      canUpdate: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(armedUnloadGuard).toBe(false);
  });
});

describe("WorkflowUnloadGuard", () => {
  it("arms the reload prompt for an owner with an edit still queued", async () => {
    const { addEventListener } = renderDirty(<WorkflowUnloadGuard />, {
      canUpdate: true,
    });

    await waitFor(() =>
      expect(
        addEventListener.mock.calls.some(([type]) => type === "beforeunload")
      ).toBe(true)
    );
  });

  it("arms no prompt a read-only viewer could never satisfy", async () => {
    const { armedUnloadGuard } = renderDirty(<WorkflowUnloadGuard />, {
      canUpdate: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(armedUnloadGuard).toBe(false);
  });
});

describe("WorkflowHeldSaveRetry", () => {
  /** A store holding workflow_a's graph after its save got no answer. */
  async function storeWithHeldGraph() {
    vi.spyOn(toast, "error").mockImplementation(() => "");
    const update = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "network is down"))
      .mockResolvedValue({ ...savedWorkflow("workflow_a"), draftRevision: 2 });
    const store = createStore();
    store.set(workflowApiAtom, { update });
    store.set(saveRetryBackoffAtom, { initialMs: 600_000, maxMs: 600_000 });
    store.set(currentWorkflowIdAtom, "workflow_a");
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_a",
      draftRevision: 1,
    });
    await store.set(
      saveWorkflowAtom,
      { nodes: [], edges: [] },
      { immediate: true }
    );
    store.set(currentWorkflowIdAtom, "workflow_b");
    store.set(hasUnsavedChangesAtom, false);
    return { store, update };
  }

  it("resends a held graph when the browser comes back online", async () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    const { store, update } = await storeWithHeldGraph();
    render(
      <Provider store={store}>
        <WorkflowHeldSaveRetry />
      </Provider>
    );

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(store.get(hasHeldGraphSaveAtom)).toBe(false));
  });

  it("arms the reload prompt while the workflow left behind holds a graph", async () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    const { store } = await storeWithHeldGraph();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(
      <Provider store={store}>
        <WorkflowHeldSaveRetry />
      </Provider>
    );

    await waitFor(() =>
      expect(
        addEventListener.mock.calls.some(([type]) => type === "beforeunload")
      ).toBe(true)
    );
  });
});
