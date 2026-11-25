import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolbarActions,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import { WorkflowToolbarChrome } from "#src/components/workflow/workflow-toolbar";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import {
  REAL_NODES,
  renderChrome,
} from "#src/components/workflow/workflow-toolbar-chrome.test-support";
import {
  clearSelectionAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { can } from "#src/lib/authorization";
import { shortcutReferenceOpenAtom } from "#src/lib/shortcut-reference-store";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import type { WorkflowToolbarActions } from "#src/components/workflow/workflow-toolbar-handlers";

/**
 * A disabled control, whether the browser's `disabled` or Base UI's
 * `focusableWhenDisabled`, which keeps Run draft and Publish focusable.
 */
const DISABLED_CONTROL = '[disabled],[aria-disabled="true"]';

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
    expect(publish.matches(DISABLED_CONTROL)).toBe(false);
  });

  it("disables Publish while a run overlay pins the canvas to a past run", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      overlayActive: true,
    });
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.matches(DISABLED_CONTROL)).toBe(true);
  });

  // Run draft and Publish stay focusable and hoverable while disabled, so the
  // reason is a tooltip on the control itself.
  it("says why Publish and Run are disabled in Runs", async () => {
    const view = renderChrome(ToolbarActions, { overlayActive: true });

    for (const [name, reason] of [
      ["Publish", "Switch to Draft to publish."],
      ["Run draft", "Switch to Draft to run."],
    ] as const) {
      const control = await view.findByRole("button", { name });
      expect(control.matches(DISABLED_CONTROL)).toBe(true);
      const trigger = control.closest("[data-slot='tooltip-trigger']");
      expect(trigger).toBeTruthy();
      fireEvent.pointerEnter(trigger as Element, { pointerType: "mouse" });
      fireEvent.mouseEnter(trigger as Element);
      fireEvent.mouseMove(trigger as Element);
      expect(await view.findByText(reason)).toBeTruthy();
    }
  });

  it("gives no disabled reason in Draft", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.closest("[data-slot='tooltip-trigger']")).toBeNull();
  });

  // Publish and the canvas read one `canvasEditingLockedAtom`, so generation
  // gates both. This case would still pass if Publish kept its own copy of the
  // condition, and it fails if a later edit drops generation from the shared
  // atom while leaving the canvas reading it.
  it("disables Publish while generation is rewriting the graph", async () => {
    const { findByRole } = renderChrome(ToolbarActions, { generating: true });
    const publish = await findByRole("button", { name: "Publish" });
    expect(publish.matches(DISABLED_CONTROL)).toBe(true);
  });

  it("disables Publish when the server and local draft both report no unpublished changes", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: false,
        publication: {
          isPublished: true,
          isPaused: false,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T16:00:00.000Z",
        },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish v2" })).matches(
        DISABLED_CONTROL
      )
    ).toBe(true);
  });

  it("keeps a never-published workflow publishable", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: false,
        publication: {
          isPublished: false,
          isPaused: false,
          hasUnpublishedChanges: false,
        },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish" })).matches(
        DISABLED_CONTROL
      )
    ).toBe(false);
  });

  it("keeps Publish enabled for a local edit awaiting autosave", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      state: {
        hasUnsavedChanges: true,
        publication: {
          isPublished: true,
          isPaused: false,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T16:00:00.000Z",
        },
      },
    });

    expect(
      (await findByRole("button", { name: "Publish v2" })).matches(
        DISABLED_CONTROL
      )
    ).toBe(false);
  });
});

describe("mobile editing actions", () => {
  it("keeps Configuration available and offers no Delete for a selection", async () => {
    const selectedNode = REAL_NODES[0];
    const view = renderChrome(ToolbarActions, {
      generating: true,
      graph: [selectedNode],
      state: { nodes: [selectedNode] },
    });
    act(() => view.store.set(selectOnlyNodeAtom, selectedNode.id));

    expect(
      (await view.findByLabelText("Configuration")).matches(DISABLED_CONTROL)
    ).toBe(false);
    expect(view.queryByTitle("Delete")).toBeNull();
  });

  it("hides Configuration while a mobile Reveal sheet shows the selection", async () => {
    (
      window as unknown as {
        happyDOM: { setViewport: (viewport: { width: number }) => void };
      }
    ).happyDOM.setViewport({ width: 390 });
    try {
      const selectedNode = REAL_NODES[0];
      const view = renderChrome(ToolbarActions, {
        graph: [selectedNode],
        state: { nodes: [selectedNode] },
      });
      expect(await view.findByLabelText("Configuration")).toBeTruthy();

      act(() => view.store.set(selectOnlyNodeAtom, selectedNode.id));
      await waitFor(() =>
        expect(view.queryByLabelText("Configuration")).toBeNull()
      );

      act(() => view.store.set(clearSelectionAtom));
      expect(await view.findByLabelText("Configuration")).toBeTruthy();
    } finally {
      (
        window as unknown as {
          happyDOM: { setViewport: (viewport: { width: number }) => void };
        }
      ).happyDOM.setViewport({ width: 1440 });
    }
  });
});

describe("WorkflowToolbarChrome menus", () => {
  // Everything about the open workflow is under its name and everything about
  // the app under Settings, so there is no third menu to guess between.
  it("offers the workflow's menu and Settings, and no Actions menu", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome);

    expect(await findByRole("menuitem", { name: "Workflow" })).toBeTruthy();
    expect(await findByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(queryByRole("menuitem", { name: "Actions" })).toBeNull();
  });

  it("holds Connections, Theme and Keyboard shortcuts under Settings", async () => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
    try {
      const { findByRole, getByRole, store } = renderChrome(
        WorkflowToolbarChrome
      );
      const settings = await findByRole("menuitem", { name: "Settings" });
      fireEvent.keyDown(settings, { key: "ArrowDown" });
      fireEvent.keyUp(settings, { key: "ArrowDown" });

      expect(getByRole("menuitem", { name: "Connections" })).toBeTruthy();
      expect(getByRole("menuitem", { name: "Theme" })).toBeTruthy();
      fireEvent.click(getByRole("menuitem", { name: /^Keyboard shortcuts/ }));
      expect(store.get(shortcutReferenceOpenAtom)).toBe(true);
    } finally {
      resetAuthorizationGrantsForTests();
    }
  });
});

describe("WorkflowToolbarChrome", () => {
  it("renders admin controls from the bootstrap grants on its first render", async () => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);

    function BootstrappedToolbar({
      actions,
      state,
      workflowId,
    }: {
      actions: WorkflowToolbarActions;
      state: WorkflowToolbarState;
      workflowId?: string | undefined;
    }) {
      return (
        <WorkflowToolbarChrome
          actions={actions}
          state={{
            ...state,
            canUpdate: can(WfGraphOperations.workflowUpdate.id),
          }}
          workflowId={workflowId}
        />
      );
    }

    try {
      const { findByRole, queryByText } = renderChrome(BootstrappedToolbar);

      expect(await findByRole("button", { name: "Publish" })).toBeTruthy();
      expect(queryByText("Read-only")).toBeNull();
      expect(
        document.querySelector("button[title='Duplicate to your workflows']")
      ).toBeNull();
    } finally {
      resetAuthorizationGrantsForTests();
    }
  });

  it("coordinates the top-level workflow menus as a menubar", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);

    const menubar = await findByRole("menubar");
    expect(
      menubar.contains(await findByRole("menuitem", { name: "Workflow" }))
    ).toBe(true);
    expect(
      menubar.contains(await findByRole("menuitem", { name: "Settings" }))
    ).toBe(true);
  });

  it("opens the menu whose trigger is hovered while another menu is open", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);
    const workflow = await findByRole("menuitem", { name: "Workflow" });
    const settings = await findByRole("menuitem", { name: "Settings" });

    fireEvent.keyDown(workflow, { key: "ArrowDown" });
    fireEvent.keyUp(workflow, { key: "ArrowDown" });
    expect(workflow.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseEnter(settings);

    await waitFor(() => {
      expect(settings.getAttribute("aria-expanded")).toBe("true");
      expect(workflow.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("shows available workspace views and moves the editor to Runs", async () => {
    const { findAllByRole, findByRole, router } = renderChrome(
      WorkflowToolbarChrome,
      {
        state: {
          publication: {
            isPublished: true,
            isPaused: false,
            hasUnpublishedChanges: false,
            publishedVersionId: "version_1",
            publishedVersion: 1,
            publishedAt: "2026-08-23T15:00:00.000Z",
          },
        },
      }
    );

    // Each view is rendered once. Below `md` the trailing group becomes the
    // overflow menu, so no view is named twice.
    expect(await findAllByRole("button", { name: "Draft" })).toHaveLength(1);
    // Draft and Runs are the views; reviewing opens from Publish.
    expect(
      [
        ...(
          await findByRole("group", { name: "Workspace view" })
        ).querySelectorAll("button"),
      ].map((button) => button.textContent)
    ).toEqual(["Draft", "Runs"]);

    const workspaceSwitcher = await findByRole("group", {
      name: "Workspace view",
    });
    const selectedView = workspaceSwitcher.querySelector(
      "button[aria-pressed='true']"
    );
    expect(selectedView?.textContent).toBe("Draft");
    expect(selectedView?.className).toContain("bg-primary");
    expect(selectedView?.className).toContain("text-primary-foreground");

    // The switch names Runs in the route, which `WorkspaceRouteSync` applies.
    fireEvent.click(await findByRole("button", { name: "Runs" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
  });

  it("puts navigation, the workflow menu and Settings on the left and the views and Publish on the right", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);

    const dashboard = await findByRole("link", { name: "Workflows" });
    const workflow = await findByRole("menuitem", { name: "Workflow" });
    const settings = await findByRole("menuitem", { name: "Settings" });
    const workspaceSwitcher = await findByRole("group", {
      name: "Workspace view",
    });
    const run = await findByRole("group", { name: "Run" });
    const publish = await findByRole("button", { name: "Publish" });
    const findStep = await findByRole("button", { name: "Find a step" });

    expect(
      [dashboard, workflow, settings].map((element) =>
        element.closest("[data-slot='workflow-toolbar-left']")
      )
    ).not.toContain(null);
    expect(
      [workspaceSwitcher, findStep, run, publish].map((element) =>
        element.closest("[data-slot='workflow-toolbar-right']")
      )
    ).not.toContain(null);
    expect(
      (await findByRole("button", { name: "Search commands or add a step" }))
        .className
    ).toContain("w-80");
    expect(findStep.className).toContain("min-[70rem]:hidden");
    const leftClasses =
      dashboard
        .closest("[data-slot='workflow-toolbar-left']")
        ?.className.split(" ") ?? [];
    // From `md` the row scrolls under the trailing group, so the leading group
    // keeps its full width and room to scroll clear of it.
    expect(leftClasses).toEqual(
      expect.arrayContaining(["md:min-w-max", "md:pr-72"])
    );
    // Below `md` the leading group shrinks to fit beside the trailing group, and
    // the workflow name truncates, so no menu label is cut off at phone width.
    expect(leftClasses).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    expect(leftClasses).not.toContain("min-w-max");
    expect(workflow.className).toContain("min-w-0");
  });

  // Published mode lives in the status strip, beside the version it governs.
  // The toolbar renders neither the setting nor the version.
  it("leaves Published mode out of the toolbar", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome, {
      state: {
        workflowMode: "test",
        publication: {
          isPublished: true,
          isPaused: false,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_7",
          publishedVersion: 7,
          publishedAt: "2026-08-23T15:00:00.000Z",
        },
      },
    });

    await findByRole("button", { name: "Publish v8" });
    expect(queryByRole("button", { name: /^Published mode/ })).toBeNull();
  });

  // Below `md` the trailing group is one button, so it must hold every desktop
  // control and disable each one for the same reason.
  it("collapses the trailing group into one overflow menu", async () => {
    const { findByRole, getByRole } = renderChrome(WorkflowToolbarChrome, {
      graph: [],
      state: {
        nodes: [],
        publication: {
          isPublished: true,
          isPaused: false,
          hasUnpublishedChanges: true,
          publishedVersionId: "version_7",
          publishedVersion: 7,
          publishedAt: "2026-08-23T15:00:00.000Z",
        },
      },
    });

    const trigger = await findByRole("button", { name: "Workflow actions" });
    expect(trigger.className).toContain("md:hidden");
    // The desktop controls are hidden at this width, so the overflow menu
    // replaces them instead of adding a control.
    expect(
      getByRole("group", { name: "Run" }).parentElement?.className
    ).toContain("md:flex");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });

    for (const name of ["Draft", "Runs"]) {
      expect(getByRole("menuitemradio", { name })).toBeTruthy();
    }
    expect(getByRole("menuitem", { name: "Run v7 · Live" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "Publish v8" })).toBeTruthy();
    // An empty canvas disables the draft run here as it does on the desktop
    // button.
    expect(
      getByRole("menuitem", { name: "Run draft" }).getAttribute("data-disabled")
    ).not.toBeNull();
  });

  // Choosing a view is the menu's whole errand, so the menu closes rather than
  // staying over the sheet the view opens.
  it("closes the overflow menu once a view is chosen", async () => {
    const { findByRole, getByRole, queryByRole } = renderChrome(
      WorkflowToolbarChrome
    );

    const trigger = await findByRole("button", { name: "Workflow actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    fireEvent.click(getByRole("menuitemradio", { name: "Runs" }));

    await waitFor(() => expect(queryByRole("menu")).toBeNull());
  });

  // The palette sits between the two groups, so Tab must reach it there. It
  // was previously written last and received focus after Publish.
  it("puts the palette trigger between the two groups in DOM order", async () => {
    const { findByRole } = renderChrome(WorkflowToolbarChrome);
    const palette = await findByRole("button", {
      name: "Search commands or add a step",
    });
    const trailing = palette
      .closest(".relative")
      ?.querySelector("[data-slot='workflow-toolbar-right']");
    const leading = palette
      .closest(".relative")
      ?.querySelector("[data-slot='workflow-toolbar-left']");

    expect(
      (leading?.compareDocumentPosition(palette) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      (trailing?.compareDocumentPosition(palette) ?? 0) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });

  it("keeps Settings available to a non-owner", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome, {
      state: {
        canUpdate: false,
        canExecute: false,
        canPublish: false,
        canReadRuns: false,
        canReadVersionHistory: false,
        canCompare: false,
      },
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

  describe("the Run split button", () => {
    it("runs the draft from its face in any Published mode", async () => {
      const { actions, findByRole } = renderChrome(WorkflowToolbarChrome, {
        state: { workflowMode: "live" },
      });

      fireEvent.click(await findByRole("button", { name: "Run draft" }));

      expect(actions.handleExecute).toHaveBeenCalledExactlyOnceWith("draft");
    });

    it("labels the published run with its version and mode", async () => {
      const { actions, findByRole, getByRole } = renderChrome(
        WorkflowToolbarChrome,
        {
          state: {
            workflowMode: "test",
            publication: {
              isPublished: true,
              isPaused: false,
              hasUnpublishedChanges: false,
              publishedVersionId: "version_7",
              publishedVersion: 7,
              publishedAt: "2026-08-23T15:00:00.000Z",
            },
          },
        }
      );

      const trigger = await findByRole("button", { name: "More ways to run" });
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.keyUp(trigger, { key: "ArrowDown" });

      fireEvent.click(getByRole("menuitem", { name: "Run v7 · Test" }));
      expect(actions.handleExecute).toHaveBeenCalledExactlyOnceWith(
        "published"
      );
    });

    // The draft runs as soon as the canvas has a node. A published version
    // exists only after a publish, and the menu item states that instead of
    // disappearing.
    it("gives the reason instead of a published run before the first publish", async () => {
      const { findByRole, getByRole } = renderChrome(WorkflowToolbarChrome);

      expect(
        (await findByRole("button", { name: "Run draft" })).matches(
          DISABLED_CONTROL
        )
      ).toBe(false);

      const trigger = getByRole("button", { name: "More ways to run" });
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.keyUp(trigger, { key: "ArrowDown" });

      const item = getByRole("menuitem", { name: "Nothing published yet" });
      expect(item.getAttribute("data-disabled")).not.toBeNull();
    });

    // A published version is frozen and still handles Events. Clearing the
    // canvas does not affect whether it can run, and disabling it would leave
    // no way to reach it from the editor.
    it("leaves the published run available while the canvas is empty", async () => {
      const { findByRole, getByRole } = renderChrome(WorkflowToolbarChrome, {
        graph: [],
        state: {
          nodes: [],
          publication: {
            isPublished: true,
            isPaused: false,
            hasUnpublishedChanges: true,
            publishedVersionId: "version_7",
            publishedVersion: 7,
            publishedAt: "2026-08-23T15:00:00.000Z",
          },
        },
      });

      expect(
        (await findByRole("button", { name: "Run draft" })).matches(
          DISABLED_CONTROL
        )
      ).toBe(true);

      const trigger = getByRole("button", { name: "More ways to run" });
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.keyUp(trigger, { key: "ArrowDown" });

      expect(
        getByRole("menuitem", {
          name: "Run v7 · Live",
        }).getAttribute("data-disabled")
      ).toBeNull();
    });

    // Two ghost buttons carry a transparent border, so the group draws nothing
    // between them and the pair reads as two separate controls.
    it("draws a divider between the run button and the chevron", async () => {
      const { findByRole } = renderChrome(WorkflowToolbarChrome);

      const group = (await findByRole("button", { name: "Run draft" })).closest(
        "[data-slot='button-group']"
      );

      expect(
        group?.querySelector("[data-slot='button-group-separator']")
      ).toBeTruthy();
    });

    it("renders no run controls for a viewer who does not own the workflow", async () => {
      const { findByTestId, queryByRole } = renderChrome(
        WorkflowToolbarChrome,
        {
          state: {
            canUpdate: false,
            canExecute: false,
            canPublish: false,
            canReadRuns: false,
            canReadVersionHistory: false,
            canCompare: false,
          },
        }
      );

      await findByTestId("toolbar-actions-host");
      expect(queryByRole("button", { name: "Run draft" })).toBeNull();
      expect(queryByRole("button", { name: "More ways to run" })).toBeNull();
      // The overflow menu is hidden too, because it would open onto a radio
      // group holding the one view already on screen.
      expect(queryByRole("button", { name: "Workflow actions" })).toBeNull();
    });
  });
});

describe("WorkflowToolbarChrome operation grants", () => {
  it("offers each toolbar command from its own operation grant", async () => {
    const executeOnly = renderChrome(WorkflowToolbarChrome, {
      state: {
        canUpdate: false,
        canExecute: true,
        canPublish: false,
        publication: {
          isPublished: true,
          isPaused: false,
          hasUnpublishedChanges: false,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T16:00:00.000Z",
        },
      },
    });
    expect(
      await executeOnly.findByRole("button", { name: "Run draft" })
    ).toBeTruthy();
    expect(
      (await executeOnly.findByRole("button", { name: "Run draft" })).matches(
        DISABLED_CONTROL
      )
    ).toBe(true);
    const runMenu = await executeOnly.findByRole("button", {
      name: "More ways to run",
    });
    fireEvent.keyDown(runMenu, { key: "ArrowDown" });
    fireEvent.keyUp(runMenu, { key: "ArrowDown" });
    expect(
      executeOnly
        .getByRole("menuitem", { name: "Run v1 · Live" })
        .getAttribute("data-disabled")
    ).toBeNull();
    expect(executeOnly.queryByRole("button", { name: "Publish" })).toBeNull();
    executeOnly.unmount();

    const publishOnly = renderChrome(WorkflowToolbarChrome, {
      state: { canUpdate: false, canExecute: false, canPublish: true },
    });
    expect(
      await publishOnly.findByRole("button", { name: "Publish" })
    ).toBeTruthy();
    expect(publishOnly.queryByRole("button", { name: "Run draft" })).toBeNull();
    publishOnly.unmount();

    const duplicateOnly = renderChrome(WorkflowMenuComponent, {
      state: {
        canUpdate: false,
        canDuplicate: true,
        canDelete: false,
      },
    });
    await openWorkflowMenu(duplicateOnly.findByRole);
    expect(
      duplicateOnly.getByRole("menuitem", { name: "Duplicate workflow" })
    ).toBeTruthy();
    expect(
      duplicateOnly.queryByRole("menuitem", { name: "Delete workflow" })
    ).toBeNull();
    duplicateOnly.unmount();

    const deleteOnly = renderChrome(WorkflowMenuComponent, {
      state: {
        canUpdate: false,
        canDuplicate: false,
        canDelete: true,
      },
    });
    await openWorkflowMenu(deleteOnly.findByRole);
    expect(
      deleteOnly.getByRole("menuitem", { name: "Delete workflow" })
    ).toBeTruthy();
    expect(
      deleteOnly.queryByRole("menuitem", { name: "Duplicate workflow" })
    ).toBeNull();
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
  // The menu's contents render only when it opens, which is where a broken
  // row would throw.
  it("offers what can be done to this workflow, in one menu", async () => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
    try {
      const { findByRole, getAllByRole } = renderChrome(WorkflowMenuComponent, {
        state: {
          workflowName: "Appointment reminders",
          allWorkflows: [
            { id: "workflow_1", name: "Appointment reminders" },
            { id: "workflow_2", name: "Onboarding drip" },
          ] as WorkflowToolbarState["allWorkflows"],
          publication: {
            isPublished: true,
            isPaused: false,
            hasUnpublishedChanges: true,
            publishedVersionId: "version_2",
            publishedVersion: 2,
            publishedAt: "2026-08-23T16:00:00.000Z",
          },
        },
      });

      await openWorkflowMenu(findByRole);

      // Other workflows are reached from the Workflows page and the palette,
      // and a new one from the Workflows page.
      expect(getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "Rename",
        "Duplicate workflow",
        "Pause workflow",
        "Version history",
        "Review changes",
        "Copy workflow ID",
        "Delete workflow",
      ]);
    } finally {
      resetAuthorizationGrantsForTests();
    }
  });

  it("opens the review sheet from Review changes", async () => {
    const { findByRole, getByRole, actions } = renderChrome(
      WorkflowMenuComponent
    );

    await openWorkflowMenu(findByRole);
    fireEvent.click(getByRole("menuitem", { name: "Review changes" }));

    expect(actions.handlePublish).toHaveBeenCalledTimes(1);
  });

  it("offers no Delete on a draft with no id", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowMenuComponent, {
      workflowId: undefined,
      state: { currentWorkflowId: null },
    });

    await openWorkflowMenu(findByRole);

    expect(queryByRole("menuitem", { name: "Delete workflow" })).toBeNull();
  });
});
