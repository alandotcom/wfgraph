/**
 * The read-only case, which is the one this component gets wrong by default.
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
import { WorkflowSaveStatus } from "#src/components/workflow/workflow-save-status";
import {
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";

function renderDirty(options: { isOwner: boolean }) {
  const store = createStore();
  store.set(isWorkflowOwnerAtom, options.isOwner);
  store.set(hasUnsavedChangesAtom, true);

  const addEventListener = vi.spyOn(window, "addEventListener");

  render(
    <Provider store={store}>
      <WorkflowSaveStatus />
    </Provider>
  );

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
  it("reports the pending edit and guards the reload for an owner", () => {
    const { armedUnloadGuard } = renderDirty({ isOwner: true });

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(armedUnloadGuard).toBe(true);
  });

  it("says nothing and arms no guard for a read-only viewer", () => {
    const { armedUnloadGuard } = renderDirty({ isOwner: false });

    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(armedUnloadGuard).toBe(false);
  });
});
