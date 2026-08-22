import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  ToolbarActions,
  WorkflowMenuComponent,
} from "#src/components/workflow/workflow-toolbar-chrome";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import {
  isGeneratingAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";
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
    setCurrentWorkflowName: vi.fn(),
    setCurrentWorkflowMode: vi.fn(),
    setWorkflowNameError: vi.fn(),
    setIsTransitioningFromHomepage: vi.fn(),
    isOwner: true,
    isSaving: false,
    hasUnsavedChanges: false,
    undo: vi.fn(),
    redo: vi.fn(),
    addNode: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setActiveTab: vi.fn(),
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
  };
}

function baseActions(): WorkflowToolbarActions {
  return {
    handleSave: vi.fn(async () => {}),
    handleExecute: vi.fn(async () => {}),
    handleClearWorkflow: vi.fn(),
    handleDeleteWorkflow: vi.fn(),
    loadWorkflows: vi.fn(async () => {}),
    handleDuplicate: vi.fn(),
    isDuplicating: false,
    handlePublish: vi.fn(),
    isPublishing: false,
    handleSetWorkflowMode: vi.fn(async () => {}),
  };
}

function renderChrome(
  Chrome: typeof ToolbarActions,
  lock: {
    overlayActive?: boolean;
    generating?: boolean;
    graph?: WorkflowToolbarState["nodes"];
    state?: Partial<WorkflowToolbarState>;
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
    // The overlay is only on the canvas while the Runs tab is, so both halves
    // of that state go in together.
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });
  }
  if (lock.generating) {
    store.set(isGeneratingAtom, true);
  }

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
            <ExtensionCatalogProvider value={emptyCatalog}>
              <OverlayProvider>
                {/* A host the absence cases can wait for: asserting that nothing
                  rendered is only meaningful once the router has resolved its
                  route, and this element is on screen exactly then. */}
                <div data-testid="toolbar-actions-host">
                  <Chrome
                    actions={baseActions()}
                    state={{ ...baseState(), ...lock.state }}
                    workflowId="workflow_1"
                  />
                </div>
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    ),
  });

  return render(
    <RouterProvider
      router={createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({
          initialEntries: ["/workflows/workflow_1"],
        }),
      })}
    />
  );
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

    const trigger = await findByRole("button", {
      name: "Appointment reminders",
    });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });

    for (const label of [
      "Rename",
      "Duplicate workflow",
      "Onboarding drip",
      "New workflow",
      "Delete workflow",
    ]) {
      expect(getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });
});
