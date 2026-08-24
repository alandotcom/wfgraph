import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolbarActions,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import { WorkflowToolbarChrome } from "#src/components/workflow/workflow-toolbar";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-handlers";
import {
  MANY_REAL_NODES,
  REAL_NODES,
  renderChrome,
} from "#src/components/workflow/workflow-toolbar-chrome.test-support";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

/**
 * Publish and ownership behavior is exercised directly against
 * `ToolbarActions`; the remaining cases cover the toolbar and workflow menus.
 */

describe("ToolbarActions publish gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each case awaits the button, because the router resolves its route after
  // render returns and the toolbar is on screen only from that point. Publish
  // is found by its written label now that it has one; it used to be an icon
  // square identified by its `title`.
  it("keeps Publish enabled with no run overlay open", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.hasAttribute("disabled")).toBe(false);
  });

  it("disables Publish while a run overlay pins the canvas to a past run", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      overlayActive: true,
    });
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.hasAttribute("disabled")).toBe(true);
  });

  // Publish and the canvas read one `canvasEditingLockedAtom`, so generation
  // gates both. This case would still pass if Publish kept its own copy of the
  // condition, and it fails if a later edit drops generation from the shared
  // atom while leaving the canvas reading it.
  it("disables Publish while generation is rewriting the graph", async () => {
    const { findByRole } = renderChrome(ToolbarActions, { generating: true });
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.hasAttribute("disabled")).toBe(true);
  });

  it("disables Publish when the server and local draft both report no unpublished changes", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: false,
        publication: {
          isPublished: true,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T16:00:00.000Z",
        },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish v2" })).hasAttribute(
        "disabled"
      )
    ).toBe(true);
  });

  it("keeps a never-published workflow publishable", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: false,
        publication: { isPublished: false, hasUnpublishedChanges: false },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish" })).hasAttribute("disabled")
    ).toBe(false);
  });

  it("keeps Publish enabled for a local edit awaiting autosave", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: true,
        publication: {
          isPublished: true,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T16:00:00.000Z",
        },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish v2" })).hasAttribute(
        "disabled"
      )
    ).toBe(false);
  });
});

describe("mobile editing actions", () => {
  it("keeps Configuration available and disables Delete while editing is locked", async () => {
    const selectedNode = { ...REAL_NODES[0], selected: true };
    const view = renderChrome(ToolbarActions, {
      generating: true,
      graph: [selectedNode],
      state: { nodes: [selectedNode] },
    });
    act(() => view.store.set(selectedNodeAtom, selectedNode.id));

    expect(
      (await view.findByTitle("Configuration")).hasAttribute("disabled")
    ).toBe(false);
    expect(view.getByTitle("Delete").hasAttribute("disabled")).toBe(true);
  });
});

describe("ToolbarActions ownership", () => {
  it("offers a non-owner nothing to do to someone else's workflow", async () => {
    const { findByTestId } = renderChrome(ToolbarActions, {
      state: { isOwner: false },
    });

    const host = await findByTestId("toolbar-actions-host");
    expect(host.innerHTML).toBe("");
  });
});

describe("WorkflowToolbarChrome", () => {
  it("coordinates the top-level workflow menus as a menubar", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);

    const menubar = await findByRole("menubar");
    expect(
      menubar.contains(await findByRole("menuitem", { name: "Workflow" }))
    ).toBe(true);
    expect(
      menubar.contains(await findByRole("menuitem", { name: "Actions" }))
    ).toBe(true);
    expect(
      menubar.contains(await findByRole("menuitem", { name: "Settings" }))
    ).toBe(true);
  });

  it("opens the menu whose trigger is hovered while another menu is open", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);
    const workflow = await findByRole("menuitem", { name: "Workflow" });
    const actions = await findByRole("menuitem", { name: "Actions" });

    fireEvent.keyDown(workflow, { key: "ArrowDown" });
    fireEvent.keyUp(workflow, { key: "ArrowDown" });
    expect(workflow.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseEnter(actions);

    await waitFor(() => {
      expect(actions.getAttribute("aria-expanded")).toBe("true");
      expect(workflow.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("shows available workspace views and moves the editor to Runs", async () => {
    const { findAllByRole, findByRole, store } = renderChrome(
      WorkflowToolbarChrome,
      {
        state: {
          publication: {
            isPublished: true,
            hasUnpublishedChanges: false,
            publishedVersionId: "version_1",
            publishedVersion: 1,
            publishedAt: "2026-08-23T15:00:00.000Z",
          },
        },
      }
    );

    expect(await findAllByRole("button", { name: "Draft" })).toHaveLength(2);
    expect(await findByRole("button", { name: "Changes" })).toBeTruthy();

    const workspaceSwitcher = await findByRole("group", {
      name: "Workspace view",
    });
    const selectedView = workspaceSwitcher.querySelector(
      "button[aria-pressed='true']"
    );
    expect(selectedView?.textContent).toBe("Draft");
    expect(selectedView?.className).toContain("bg-primary");
    expect(selectedView?.className).toContain("text-primary-foreground");

    fireEvent.click(await findByRole("button", { name: "Runs" }));
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });

  it("keeps navigation, Actions, and Settings on the left with mode and Publish on the right", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);

    const dashboard = await findByRole("link", { name: "Dashboard" });
    const workflow = await findByRole("menuitem", { name: "Workflow" });
    const actions = await findByRole("menuitem", { name: "Actions" });
    const settings = await findByRole("menuitem", { name: "Settings" });
    const workspaceSwitcher = await findByRole("group", {
      name: "Workspace view",
    });
    const mode = await findByRole("button", { name: "Live mode" });
    const publish = await findByRole("button", { name: "Publish" });

    expect(
      [dashboard, workflow, actions, settings].map((element) =>
        element.closest("[data-slot='workflow-toolbar-left']")
      )
    ).not.toContain(null);
    expect(
      [workspaceSwitcher, mode, publish].map((element) =>
        element.closest("[data-slot='workflow-toolbar-right']")
      )
    ).not.toContain(null);
    expect(
      (await findByRole("button", { name: "Search commands or add a step" }))
        .className
    ).toContain("w-80");
  });

  it("keeps Settings available to a non-owner", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome, {
      state: { isOwner: false },
    });

    expect(await findByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(queryByRole("button", { name: "Publish" })).toBeNull();
    expect(queryByRole("button", { name: "Runs" })).toBeNull();
    expect(queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("keeps Changes unavailable before the first publication", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome);

    expect(await findByRole("button", { name: "Runs" })).toBeTruthy();
    expect(queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("constrains each desktop side around the viewport-centred palette", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);
    const palette = await findByRole("button", {
      name: "Search commands or add a step",
    });
    const left = palette
      .closest(".relative")
      ?.querySelector("[data-slot='workflow-toolbar-left']");
    const right = palette
      .closest(".relative")
      ?.querySelector("[data-slot='workflow-toolbar-right']");

    expect(left?.className).toContain("min-[70rem]:max-w-[calc(50%-10rem)]");
    expect(left?.className).toContain("min-[70rem]:overflow-x-auto");
    expect(right?.className).toContain("min-[70rem]:max-w-[calc(50%-10rem)]");
    expect(right?.className).toContain("min-[70rem]:overflow-x-auto");
    expect(palette.parentElement?.parentElement?.className).toContain(
      "absolute inset-x-0"
    );
  });

  it("uses amber Test mode and sends a mode change through the existing handler", async () => {
    const { actions, findByRole, getByRole } = renderChrome(
      WorkflowToolbarChrome,
      { state: { workflowMode: "test" } }
    );

    const trigger = await findByRole("button", { name: "Test mode" });
    expect(trigger.className).toContain("bg-warning/10");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    expect(
      getByRole("menuitemradio", {
        name: /Routes configured messages to test recipients/,
      })
    ).toBeTruthy();
    fireEvent.click(
      getByRole("menuitemradio", {
        name: /Sends messages to configured recipients/,
      })
    );

    expect(actions.handleSetWorkflowMode).toHaveBeenCalledWith("live");
  });
});

describe("ToolbarActions menu", () => {
  it("names every action it offers, and offers the mode it is not in", async () => {
    const { findByRole, getByRole } = renderChrome(ToolbarActions);

    // Base UI opens a menu on the pointer going down, not on the click that
    // follows it, so a bare `click` leaves the popup closed.
    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });

    // A shortcut hint is part of the item's own text, so each name is matched
    // from its start rather than whole. Every hint here is a binding that
    // exists: the shortcuts are the item's promise, not decoration.
    for (const label of [
      /^Add step/,
      /^Run workflow/,
      /^Undo/,
      /^Redo/,
      /^Tidy layout/,
      /^Keyboard shortcuts/,
    ]) {
      expect(getByRole("menuitem", { name: label })).toBeTruthy();
    }
    // Live is the mode `baseState` is in, so the offer is the other one.
    expect(getByRole("menuitem", { name: "Switch to Test mode" })).toBeTruthy();
  });

  it("renders every canvas command through the keyboard submenu", async () => {
    const { findByRole, getByRole } = renderChrome(ToolbarActions);

    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });

    const keyboard = getByRole("menuitem", { name: /^Keyboard shortcuts/ });
    fireEvent.keyDown(keyboard, { key: "ArrowRight" });
    fireEvent.keyUp(keyboard, { key: "ArrowRight" });

    for (const label of [
      /^Fit view/,
      /^Copy selection/,
      /^Paste/,
      /^Duplicate selection/,
      /^Group selection/,
    ]) {
      expect(getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });
});

describe("ToolbarActions menu under a pinned run", () => {
  // The four items that write to the graph read `canvasEditingLockedAtom`, the
  // same atom the canvas reads, so a run pinned to the canvas refuses them the
  // way it refuses a drag. The buttons these replaced checked only generation
  // and would happily edit a draft nobody could see.
  it("refuses every graph edit while a past run is on the canvas", async () => {
    const { findByRole, getByRole } = renderChrome(ToolbarActions, {
      graph: MANY_REAL_NODES,
      overlayActive: true,
      state: { canUndo: true, canRedo: true, nodes: MANY_REAL_NODES },
    });

    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });

    for (const label of [/^Add step/, /^Undo/, /^Redo/, /^Tidy layout/]) {
      expect(
        getByRole("menuitem", { name: label }).getAttribute("data-disabled")
      ).not.toBeNull();
    }
  });
});

/**
 * Open the workflow menu, which renders nothing until it is. The keyboard is
 * the path: a pointer press reaches the menu through events happy-dom does not
 * deliver whole.
 */
async function openWorkflowMenu(
  findByRole: ReturnType<typeof renderChrome>["findByRole"]
) {
  const trigger = await findByRole("button", { expanded: false });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyUp(trigger, { key: "ArrowDown" });
}

describe("WorkflowMenuComponent", () => {
  // The menu's contents render only when it opens, and a `Menu.GroupLabel`
  // written outside a `Menu.Group` throws there rather than at import: the
  // whole editor route went to its error boundary the first time this opened.
  it("opens on the workflow it belongs to and offers what can be done to it", async () => {
    const { findByRole, getByRole } = renderChrome(WorkflowMenuComponent, {
      state: {
        workflowName: "Appointment reminders",
        allWorkflows: [
          { id: "workflow_1", name: "Appointment reminders" },
          { id: "workflow_2", name: "Onboarding drip" },
        ] as WorkflowToolbarState["allWorkflows"],
      },
    });

    await openWorkflowMenu(findByRole);

    for (const label of [
      "Rename",
      "Duplicate workflow",
      "Onboarding drip",
      "New workflow",
      "Clear workflow",
      "Delete workflow",
    ]) {
      expect(getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  // Clear moved here off the properties panel, so the item has to reach the
  // same handler the panel's button did. An item that only reads right is one
  // nothing has ever pressed.
  it("clears the workflow through the handler the panel used", async () => {
    const { findByRole, getByRole, actions } = renderChrome(
      WorkflowMenuComponent
    );

    await openWorkflowMenu(findByRole);
    fireEvent.click(getByRole("menuitem", { name: "Clear workflow" }));

    expect(actions.handleClearWorkflow).toHaveBeenCalledTimes(1);
  });

  // The panel gated Clear on ownership alone. A draft nobody has saved yet has
  // no id and every reason to want emptying, so gating it with Delete would
  // have taken the control off the canvas most likely to need it.
  it("still offers Clear on a draft with no id, and no Delete", async () => {
    const { findByRole, getByRole, queryByRole } = renderChrome(
      WorkflowMenuComponent,
      { workflowId: undefined, state: { currentWorkflowId: null } }
    );

    await openWorkflowMenu(findByRole);

    expect(getByRole("menuitem", { name: "Clear workflow" })).toBeTruthy();
    expect(queryByRole("menuitem", { name: "Delete workflow" })).toBeNull();
  });

  // `clearWorkflowAtom` returns early while a past run is pinned to the canvas.
  // Enabled, the item spends a destructive confirmation on nothing at all.
  it("refuses Clear while a past run pins the canvas", async () => {
    const { findByRole, getByRole } = renderChrome(WorkflowMenuComponent, {
      overlayActive: true,
    });

    await openWorkflowMenu(findByRole);

    expect(
      getByRole("menuitem", { name: "Clear workflow" }).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull();
  });
});
