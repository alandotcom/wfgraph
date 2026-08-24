import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  ToolbarActions,
  ToolbarPublishControls,
  CommandPaletteTrigger,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import { WorkflowToolbarChrome } from "#src/components/workflow/workflow-toolbar";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  isGeneratingAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/**
 * `publishDisabled` used to check only isGenerating / isSaving / node
 * presence, so Publish stayed clickable while a run overlay pinned the canvas
 * to a past run and hid the real draft (#39). This exercises the wiring
 * directly against `ToolbarActions`, since `publishDisabled` is computed
 * inline rather than exported.
 *
 * `ToolbarActions` is also the whole of what an owner may do to the graph, so
 * the non-owner case is here too: a public workflow shows none of it.
 */

const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

// One real lifecycle node, so the "at least one real step" arm of
// `publishDisabled` is already satisfied and the overlay is the only thing
// left that can gate the button.
const REAL_NODES = toWorkflowGraphData(
  createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle" },
      },
    ],
    edges: [],
  })
).nodes.map(toEditorNode);

/**
 * Two real steps, which is the fewest "Tidy layout" will act on. The single
 * lifecycle node above leaves it disabled for want of anything to arrange, and
 * a case about the run lock has to fail for the run lock.
 */
const MANY_REAL_NODES = toWorkflowGraphData(
  createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle" },
      },
      {
        id: "action_1",
        type: "action",
        position: { x: 0, y: 200 },
        data: { label: "Step", type: "action" },
      },
    ],
    edges: [],
  })
).nodes.map(toEditorNode);

function baseState(): WorkflowToolbarState {
  return {
    nodes: REAL_NODES,
    edges: [],
    isExecuting: false,
    setIsExecuting: vi.fn(),
    isGenerating: false,
    clearWorkflow: vi.fn(),
    updateNodeData: vi.fn(),
    currentWorkflowId: "workflow_1",
    workflowName: "Workflow",
    workflowMode: "live",
    setCurrentWorkflowMode: vi.fn(),
    isOwner: true,
    isSaving: false,
    hasUnsavedChanges: false,
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
    publication: undefined,
  };
}

function baseActions(): WorkflowToolbarActions {
  return {
    handleExecute: vi.fn(async () => {}),
    handleClearWorkflow: vi.fn(),
    handleDeleteWorkflow: vi.fn(),
    loadWorkflows: vi.fn(async () => {}),
    handleDuplicate: vi.fn(),
    isDuplicating: false,
    handlePublish: vi.fn(),
    confirmPublish: vi.fn(),
    isPublishing: false,
    isComparing: false,
    publishReview: null,
    setPublishReviewOpen: vi.fn(),
    handleSetWorkflowMode: vi.fn(async () => {}),
  };
}

type ChromeProps = {
  actions: WorkflowToolbarActions;
  state: WorkflowToolbarState;
  workflowId?: string;
};

function renderChrome(
  Chrome: React.ComponentType<ChromeProps>,
  lock: {
    overlayActive?: boolean;
    generating?: boolean;
    graph?: WorkflowToolbarState["nodes"];
    state?: Partial<WorkflowToolbarState>;
    /** Null is a draft nobody has saved yet, which has no id to act on. */
    workflowId?: string | undefined;
    /** What the palette's node-type page has to offer. */
    catalog?: ExtensionCatalog;
  } = {}
) {
  const store = createStore();
  // Built once per render of the harness, not once per render of the tree: an
  // inline `new QueryClient()` inside the route component hands every re-render
  // a fresh cache, which is a refetch loop the first case with a query would
  // find the hard way.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (lock.graph) {
    // "Tidy layout" reads the graph off the store rather than off the state
    // prop, because the pass it runs is the canvas's own.
    store.set(loadWorkflowGraphAtom, { nodes: lock.graph, edges: [] });
  }
  if (lock.overlayActive) {
    // The overlay is only on the canvas while the Runs workspace is, so both halves
    // of that state go in together.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });
  }
  if (lock.generating) {
    store.set(isGeneratingAtom, true);
  }
  // Which workflow is open, as the loader would have written it. The palette
  // refuses to open without one, and the workflow menu's own draft case passes
  // `workflowId: undefined` to get exactly that.
  store.set(
    currentWorkflowIdAtom,
    ("workflowId" in lock ? lock.workflowId : "workflow_1") ?? null
  );
  store.set(isWorkflowOwnerAtom, lock.state?.isOwner ?? true);

  // Built once rather than inside the route component, so a case can assert on
  // the spy the chrome was actually handed: re-created per render, every click
  // would land on an object the test never saw.
  const actions = baseActions();
  const workflowId = "workflowId" in lock ? lock.workflowId : "workflow_1";

  // The toolbar calls `useNavigate` for the workflow switcher, so it needs a
  // router above it. One root route carries the whole tree, since no case here
  // reads a param or a search value; the toolbar is rendered directly rather
  // than reached by a path.
  const rootRoute = createRootRoute({
    component: () => (
      <JotaiProvider store={store}>
        {/* The workflow menu carries the create dialog, which is a mutation. */}
        <QueryClientProvider client={queryClient}>
          <ReactFlowProvider>
            {/* The Actions menu's "Tidy layout" runs a layout pass, which reads
              the catalog for what each node type measures. */}
            <ExtensionCatalogProvider value={lock.catalog ?? emptyCatalog}>
              <OverlayProvider>
                {/* A host the absence cases can wait for: asserting that nothing
                  rendered is only meaningful once the router has resolved its
                  route, and this element is on screen exactly then. */}
                <div data-testid="toolbar-actions-host">
                  <Chrome
                    actions={actions}
                    state={{ ...baseState(), ...lock.state }}
                    workflowId={workflowId}
                  />
                </div>
                {/* The production toolbar places these in separate left, centre,
                    and right groups. This harness keeps the existing focused
                    Actions tests while mounting the controls they coordinate. */}
                {Chrome === ToolbarActions && (lock.state?.isOwner ?? true) ? (
                  <>
                    <CommandPaletteTrigger />
                    <ToolbarPublishControls
                      actions={actions}
                      state={{ ...baseState(), ...lock.state }}
                    />
                  </>
                ) : null}
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    ),
  });

  return {
    ...render(
      <RouterProvider
        router={createRouter({
          routeTree: rootRoute,
          history: createMemoryHistory({
            initialEntries: ["/workflows/workflow_1"],
          }),
        })}
      />
    ),
    actions,
    store,
  };
}

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
    const workflow = await findByRole("button", { name: "Workflow" });
    const actions = await findByRole("button", { name: "Actions" });
    const settings = await findByRole("button", { name: "Settings" });
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
      (await findByRole("button", { name: "Search or add a step" })).className
    ).toContain("w-80");
  });

  it("keeps Settings available to a non-owner", async () => {
    const { findByRole, queryByRole } = renderChrome(WorkflowToolbarChrome, {
      state: { isOwner: false },
    });

    expect(await findByRole("button", { name: "Settings" })).toBeTruthy();
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
      name: "Search or add a step",
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

/**
 * The command palette is mounted by `ToolbarActions`, so what is exercised here
 * is the wiring: the key that opens it, the box in the bar that opens it, the
 * two conditions that refuse it, and the Actions menu item that skips its root
 * page. The page stack itself is pure and lives in `command-palette.test.ts`.
 */
const ONE_ACTION_CATALOG: ExtensionCatalog = {
  events: [],
  integrations: [],
  actions: [
    {
      id: "Wait",
      label: "Wait",
      description: "Delay execution",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
};

/** The palette's own search box, which is the only textbox in this tree. */
function paletteInput(container: HTMLElement | Document = document) {
  return container.querySelector<HTMLInputElement>("[role='combobox']");
}

function pressCommandK(target: Document | Element = document) {
  fireEvent.keyDown(target, { key: "k", metaKey: true });
}

describe("the command palette", () => {
  it("opens on Cmd+K, at the root page", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    pressCommandK();

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
  });

  // The same rule Cmd+Enter follows: a chord is not worth a keystroke taken out
  // of a field somebody is typing in.
  it("leaves Cmd+K alone while a text field has focus", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    const field = document.createElement("input");
    document.body.append(field);
    pressCommandK(field);
    field.remove();

    expect(paletteInput()).toBeNull();
  });

  /**
   * The palette names itself, because none of what it does is legible from a
   * placeholder: that is the weakest source an accessible name can come from,
   * and this one's changes underneath the reader as the page does. The live
   * region is the only signal of that page change that reaches them at all.
   */
  it("names its box, its list, its way out and the page it is on", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const { getByRole, getByText } = rendered;
    await openedPalette(rendered);

    expect(
      getByRole("combobox", { name: "Search commands and step types" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Commands" })).toBeTruthy();
    // Base UI asks for a close inside every modal popup, for the touch screen
    // reader that has no Escape key and cannot reach the backdrop.
    expect(getByRole("button", { name: "Close command palette" })).toBeTruthy();
    expect(getByText("Commands.").getAttribute("aria-live")).toBe("polite");

    chooseAddStep(rendered);

    expect(
      getByRole("combobox", { name: "Search commands and step types" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Step types" })).toBeTruthy();
    expect(getByText(/^Add step\. Choose/).getAttribute("aria-live")).toBe(
      "polite"
    );
  });

  // The chord is announced once, by `aria-keyshortcuts`. Inside the accessible
  // name the printed `⌘K` read as part of what the button is called.
  it("keeps the printed chord out of the trigger's name", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    const trigger = await findByRole("button", {
      name: "Search or add a step",
    });

    expect(trigger.getAttribute("aria-keyshortcuts")).toMatch(
      /^(Meta|Control)\+K$/
    );
  });

  it("opens from the box in the bar", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    fireEvent.click(
      await findByRole("button", { name: /Search or add a step/ })
    );

    expect(paletteInput()).not.toBeNull();
  });

  // A step added under a run overlay lands on a draft nobody can see, which is
  // the same reason Publish and every menu item that writes the graph refuse.
  it("refuses both ways in while a past run pins the canvas", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      overlayActive: true,
    });

    const trigger = await findByRole("button", {
      name: /Search or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // Generation used to fall between the palette's lock and its items': Cmd+K
  // opened a palette whose every item was disabled, "Add step" included, which
  // the Actions menu refuses outright in the same state.
  it("refuses both ways in while generation is rewriting the graph", async () => {
    const { findByRole } = renderChrome(ToolbarActions, { generating: true });

    const trigger = await findByRole("button", {
      name: /Search or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // Someone who chose "Add step" has already said what they want, so the root
  // page has nothing left to ask them.
  it("sends the Actions menu's Add step straight to the node types", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });

    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    fireEvent.click(await findByRole("menuitem", { name: /^Add step/ }));

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );
    expect(await findByRole("option", { name: /^Wait/ })).toBeTruthy();
  });

  it("shows a non-owner no way into it", async () => {
    const { findByTestId } = renderChrome(ToolbarActions, {
      state: { isOwner: false },
    });
    await findByTestId("toolbar-actions-host");

    pressCommandK();

    expect(paletteInput()).toBeNull();
  });

  // A held palette belongs to the workflow it was opened over. Opening another
  // one throws it away, so returning to the first does not spring it back.
  it("throws the palette away when another workflow opens", async () => {
    const { findByRole, store } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });
    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));

    pressCommandK();
    expect(paletteInput()).not.toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_2"));
    expect(paletteInput()).toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));
    expect(paletteInput()).toBeNull();
  });

  /**
   * The four paths below are the ones a browser pass walks past. Escape and
   * Backspace already have focus on the input, so they never noticed that the
   * header swaps a `<button>` for an `<svg>` when the last page pops: the
   * element the pointer just acted on unmounts, focus falls to `<body>`, and
   * the dialog's trap parks it on the popup rather than the search box.
   */
  async function openedPalette(
    rendered: Awaited<ReturnType<typeof renderChrome>>
  ) {
    await rendered.findByRole("button", { name: "Publish" });
    pressCommandK();
    const input = paletteInput();
    if (!input) {
      throw new Error("the palette did not open");
    }
    return input;
  }

  /** Take the "Add step" item, which is the way to the second page. */
  function chooseAddStep(rendered: ReturnType<typeof renderChrome>) {
    fireEvent.click(rendered.getByRole("option", { name: /^Add step/ }));
  }

  // An empty list is two different facts and the reader is owed the right one.
  // A host that passed no integrations gets an empty catalog and no error, so
  // this is the surface that has to say which of the two happened.
  it("tells an empty catalog apart from a query that matched nothing", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);
    fireEvent.change(paletteInput() ?? input, { target: { value: "zzqq" } });

    expect(rendered.getByText("Nothing matches that.")).toBeTruthy();

    rendered.unmount();

    const empty = renderChrome(ToolbarActions);
    await openedPalette(empty);

    chooseAddStep(empty);

    expect(empty.getByText("No step types are available yet.")).toBeTruthy();
  });

  it("hands focus back to the search box when Back is clicked", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    await openedPalette(rendered);
    chooseAddStep(rendered);

    const back = rendered.getByRole("button", { name: "Back to commands" });
    // A pointer press puts focus on the control before the click lands, which
    // is the state that made the swap drop focus out of the palette.
    back.focus();
    fireEvent.click(back);

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
    expect(document.activeElement).toBe(paletteInput());
  });

  it("goes back a page on Escape, and closes on the next one", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()).toBeNull();
  });

  it("goes back a page on Backspace once the box is empty", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    const onStepPage = paletteInput() ?? input;
    // A Backspace with something to delete stays on the page.
    fireEvent.change(onStepPage, { target: { value: "wa" } });
    fireEvent.keyDown(onStepPage, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );

    fireEvent.change(paletteInput() ?? input, { target: { value: "" } });
    fireEvent.keyDown(paletteInput() ?? input, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, or add a step"
    );
  });

  // The page stack clears the query, and this is that reaching the box the
  // reader is looking at. The pointer is the path: choosing an item is also the
  // moment Base UI would offer the item's own text back as the next value.
  it("empties the box when a page is chosen with the pointer", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "add" } });
    expect(paletteInput()?.value).toBe("add");

    chooseAddStep(rendered);

    expect(paletteInput()?.value).toBe("");
  });
});
