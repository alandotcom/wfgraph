import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Schema } from "effect";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  startedEdge,
} from "#src/lib/upstream-node-fields-test-support";
import {
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { activeRevealPresentationAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { CanvasReveal } from "./canvas-reveal";

const catalog: ExtensionCatalog = {
  entities: [],
  integrations: [],
  actions: [],
  events: [
    anEvent({
      name: "app/created",
      label: "Appointment created",
      schema: Schema.Struct({ id: Schema.String }),
    }),
    anEvent({
      name: "app/canceled",
      label: "Appointment canceled",
      schema: Schema.Struct({ id: Schema.String }),
    }),
    // Declared, but left off the Lifecycle Rules below, so an edge naming it
    // is a stored connection that has fallen out of reach.
    anEvent({
      name: "app/removed",
      label: "Appointment removed",
      schema: Schema.Struct({ id: Schema.String }),
    }),
  ],
};

const lifecycleNode = anEntryNode({
  startEvents: ["app/created", "app/canceled"],
});
const splitNode = createNode({
  id: "split",
  type: "action",
  label: "Split",
  config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
});
const sendNode = createNode({
  id: "send",
  type: "action",
  label: "Send reminder",
  config: { actionType: BUILT_IN_ACTION_IDS.wait },
});
const removedTargetNode = createNode({
  id: "removed-target",
  type: "action",
  label: "Removed target",
  config: { actionType: BUILT_IN_ACTION_IDS.wait },
});
const retiredTargetNode = createNode({
  id: "retired-target",
  type: "action",
  label: "Retired target",
  config: { actionType: BUILT_IN_ACTION_IDS.wait },
});

/** An event-mode Wait that parks on `app/canceled`. */
const waitNode = createNode({
  id: "wait",
  type: "action",
  label: "Wait for cancel",
  config: {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "event",
    waitFor: [{ event: "app/canceled" }],
  },
});

const BASE_EDGES: WorkflowEdge[] = [
  startedEdge("split"),
  createEdge({
    id: "e-created",
    source: "split",
    target: "send",
    sourceHandle: eventSplitOutlet("app/created"),
  }),
  createEdge({
    id: "e-removed",
    source: "split",
    target: "removed-target",
    sourceHandle: eventSplitOutlet("app/removed"),
  }),
  createEdge({
    id: "e-retired",
    source: "split",
    target: "retired-target",
    sourceHandle: eventSplitOutlet("app/retired"),
  }),
];

function FakeCanvas() {
  return (
    <div data-testid="workflow-canvas">
      {["split", "lifecycle-1", "wait"].map((id) => (
        <div className="react-flow__node" data-id={id} key={id} tabIndex={0}>
          {id}
        </div>
      ))}
    </div>
  );
}

async function renderEventSplit(input: {
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[] | undefined;
}) {
  const nodes = input.nodes;
  const edges = input.edges ?? [];
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  store.set(loadWorkflowGraphAtom, { nodes, edges });
  store.set(
    workflowIssuesAtom,
    collectWorkflowIssues({ nodes, edges, catalog, integrations: [] })
  );
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(store, {});

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <FakeCanvas />
        <CanvasReveal />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/wf_1"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <ReactFlowProvider>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </ReactFlowProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");
  await act(async () => {
    store.set(selectOnlyNodeAtom, "split");
  });
  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const region = (name: string) => {
    const section = within(
      view.getByRole("complementary", { name: "Event Split inspector" })
    )
      .getByRole("heading", { name })
      .closest("section");
    if (!section) {
      throw new Error(`no Browse section is headed ${name}`);
    }
    return section;
  };
  return { view, store, update, aside, region };
}

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

beforeEach(() => {
  setViewportWidth(1440);
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
});

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

describe("Event Split Browse", () => {
  it("explains where outlets come from and offers no Focus", async () => {
    const { aside, view } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: [startedEdge("split")],
    });

    expect(aside()?.dataset.level).toBe("browse");
    expect(view.getByRole("heading", { name: "Split" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Focus editor" })).toBeNull();
    expect(aside()?.textContent).toContain(
      "Its outlets are the Events that reach it from the Lifecycle Node's Start Events"
    );
  });

  it("lists a reachable outlet's Event and connection destination", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: [
        startedEdge("split"),
        createEdge({
          id: "e-created",
          source: "split",
          target: "send",
          sourceHandle: eventSplitOutlet("app/created"),
        }),
      ],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("Appointment created");
    expect(outlets.textContent).toContain("app/created");
    expect(outlets.textContent).toContain("Continues to Send reminder");
  });

  it("shows a disconnected outlet's own state", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode],
      edges: [startedEdge("split")],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("Appointment canceled");
    expect(outlets.textContent).toContain(
      "Not connected. A run arriving on Appointment canceled ends here."
    );
  });

  it("lists every named outlet when there are several", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode],
      edges: [startedEdge("split")],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("Appointment created");
    expect(outlets.textContent).toContain("Appointment canceled");
  });

  it("marks a stored outlet the app no longer declares", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, retiredTargetNode],
      edges: [
        startedEdge("split"),
        createEdge({
          id: "e-retired",
          source: "split",
          target: "retired-target",
          sourceHandle: eventSplitOutlet("app/retired"),
        }),
      ],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("app/retired");
    expect(outlets.textContent).toContain("Not declared by this app");
    expect(outlets.textContent).toContain("Continues to Retired target");
  });

  it("marks a stored outlet that no longer reaches this node", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, removedTargetNode],
      edges: [
        startedEdge("split"),
        createEdge({
          id: "e-removed",
          source: "split",
          target: "removed-target",
          sourceHandle: eventSplitOutlet("app/removed"),
        }),
      ],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("Appointment removed");
    expect(outlets.textContent).toContain(
      "No longer reaches this Event Split from the Lifecycle Node's Start Events."
    );
    expect(outlets.textContent).toContain("Continues to Removed target");
  });

  it("explains an Event Split with no Event source above it", async () => {
    const disconnectedSplit = createNode({
      id: "split",
      type: "action",
      label: "Split",
      config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
    });
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, disconnectedSplit],
      edges: [],
    });

    expect(region("Splits by Event").textContent).toContain(
      "No Event reaches this Event Split yet."
    );
    expect(region("Splits by Event").querySelector("button")).toBeNull();
  });

  it("shows a connection that leaves by no outlet with its target", async () => {
    const { region } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: [
        startedEdge("split"),
        createEdge({ id: "e-bare", source: "split", target: "send" }),
      ],
    });

    const outlets = region("Splits by Event");
    expect(outlets.textContent).toContain("A connection leaves by no outlet");
    expect(outlets.textContent).toContain("Continues to Send reminder");
  });

  it("opens the Lifecycle Node's Cancel Events for a split on the Canceled side", async () => {
    const { view, aside } = await renderEventSplit({
      nodes: [anEntryNode({ cancelEvents: ["app/canceled"] }), splitNode],
      edges: [
        createEdge({
          id: "e-canceled",
          source: "lifecycle-1",
          target: "split",
          sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        }),
      ],
    });

    expect(aside()?.textContent).toContain(
      "reach it from the Lifecycle Node's Cancel Events"
    );
    expect(
      view.queryByRole("button", { name: "Open Lifecycle Start Events" })
    ).toBeNull();
    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Cancel Events" })
    );

    expect(aside()?.dataset.level).toBe("focus");
    expect(
      view
        .getByRole("button", { name: /^Cancel Events/ })
        .getAttribute("aria-current")
    ).toBe("true");
  });

  it("opens the event-mode Wait above a split and returns on Back", async () => {
    const { view, aside } = await renderEventSplit({
      nodes: [lifecycleNode, waitNode, splitNode],
      edges: [
        startedEdge("wait"),
        createEdge({ id: "e-wait", source: "wait", target: "split" }),
      ],
    });

    expect(aside()?.textContent).toContain(
      "reach it from the Wait Subscriptions of Wait for cancel"
    );
    expect(
      view.queryByRole("button", { name: "Open Lifecycle Start Events" })
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open Wait for cancel" }));

    // The step inspector's body can take more than one render under load.
    expect(
      await view.findByRole("complementary", { name: "Step inspector" })
    ).toBeTruthy();
    expect(aside()?.dataset.level).toBe("browse");

    fireEvent.click(await view.findByRole("button", { name: "Back" }));

    expect(
      await view.findByRole("complementary", { name: "Event Split inspector" })
    ).toBeTruthy();
  });

  it("opens the Lifecycle Node's Start Events and returns on Back", async () => {
    const { view, aside } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: BASE_EDGES,
    });

    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Start Events" })
    );

    expect(aside()?.dataset.level).toBe("focus");
    expect(view.getByRole("heading", { name: "Lifecycle" })).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: /^Start Events/ })
        .getAttribute("aria-current")
    ).toBe("true");

    fireEvent.click(view.getByRole("button", { name: "Back" }));

    expect(view.getByRole("heading", { name: "Split" })).toBeTruthy();
    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Event Split inspector" })
    ).toBeTruthy();
  });

  it("returns to the split on Escape the same way as on Back", async () => {
    const { view, aside } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: BASE_EDGES,
    });

    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Start Events" })
    );
    expect(aside()?.dataset.level).toBe("focus");

    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });

    expect(
      view.getByRole("complementary", { name: "Event Split inspector" })
    ).toBeTruthy();
    expect(aside()?.dataset.level).toBe("browse");
  });

  it("forgets the split once Reveal closes, so Back later stays within the Lifecycle Node", async () => {
    const { view, store, aside } = await renderEventSplit({
      nodes: [lifecycleNode, splitNode, sendNode],
      edges: BASE_EDGES,
    });

    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Start Events" })
    );
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await act(async () => {
      store.set(clearSelectionAtom);
    });
    await act(async () => {
      store.set(selectOnlyNodeAtom, "lifecycle-1");
    });
    expect(store.get(activeRevealPresentationAtom).inspectedOrigin).toBeNull();
    expect(aside()?.dataset.level).toBe("focus");

    fireEvent.click(view.getByRole("button", { name: "Back" }));

    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Lifecycle inspector" })
    ).toBeTruthy();
    expect(store.get(activeRevealPresentationAtom).inspected).toEqual({
      kind: "node",
      id: "lifecycle-1",
    });
  });
});
