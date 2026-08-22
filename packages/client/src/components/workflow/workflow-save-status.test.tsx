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

import { render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowSaveStatus,
  WorkflowUnloadGuard,
} from "#src/components/workflow/workflow-save-status";
import {
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";

function renderDirty(
  component: React.ReactNode,
  options: { isOwner: boolean }
) {
  const store = createStore();
  store.set(isWorkflowOwnerAtom, options.isOwner);
  store.set(hasUnsavedChangesAtom, true);

  const addEventListener = vi.spyOn(window, "addEventListener");

  render(<Provider store={store}>{component}</Provider>);

  return {
    armedUnloadGuard: addEventListener.mock.calls.some(
      ([type]) => type === "beforeunload"
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkflowSaveStatus", () => {
  it("reports the pending edit for an owner", () => {
    renderDirty(<WorkflowSaveStatus />, { isOwner: true });

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("says nothing for a read-only viewer", () => {
    renderDirty(<WorkflowSaveStatus />, { isOwner: false });

    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("arms no guard of its own, which is the strip's to mount", () => {
    // The guard used to live here, which meant pinning a run to the canvas
    // unmounted this label and disarmed the guard with it.
    const { armedUnloadGuard } = renderDirty(<WorkflowSaveStatus />, {
      isOwner: true,
    });

    expect(armedUnloadGuard).toBe(false);
  });
});

describe("WorkflowUnloadGuard", () => {
  it("arms the reload prompt for an owner with an edit still queued", () => {
    const { armedUnloadGuard } = renderDirty(<WorkflowUnloadGuard />, {
      isOwner: true,
    });

    expect(armedUnloadGuard).toBe(true);
  });

  it("arms no prompt a read-only viewer could never satisfy", () => {
    const { armedUnloadGuard } = renderDirty(<WorkflowUnloadGuard />, {
      isOwner: false,
    });

    expect(armedUnloadGuard).toBe(false);
  });
});
