import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  type ConfirmRequest,
  type NodeConfigFrame,
  NodeConfigPanel,
} from "#src/components/workflow/node-config-panel";
import {
  loadWorkflowGraphAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { orpcQuery } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

const catalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [{ path: "appointment.id", type: "string" }],
    },
  ],
  actions: [],
  integrations: [],
};

afterEach(resetAuthorizationGrantsForTests);

function lifecycleNode(id = "lifecycle_1"): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: true,
        },
      },
    },
  };
}

function groupNode(): WorkflowNode {
  return {
    id: "group_1",
    type: "group",
    position: { x: 0, y: 200 },
    data: { label: "Frame", type: "group", config: {} },
  };
}

/**
 * The panel in the rail's frame, over a router and a query client because the
 * write half it mounts reaches both. `confirm` is captured rather than rendered:
 * what a frame does with a request is the frame's business, and no case here is
 * about the dialog.
 */
function renderPanel({
  nodes = [lifecycleNode(), groupNode()],
  edges = [],
  selected = null,
  hasPublishedVersion = false,
  workspaceView = "draft",
}: {
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  selected?: string | null;
  hasPublishedVersion?: boolean;
  workspaceView?: "draft" | "runs" | "changes";
} = {}) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes, edges });
  store.set(selectedNodeAtom, selected);
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  store.set(workflowWorkspaceViewAtom, workspaceView);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(
    orpcQuery.workflow.getById.queryKey({ input: { workflowId: "wf_1" } }),
    {
      id: "wf_1",
      publishedVersionId: hasPublishedVersion ? "version_1" : undefined,
      publishedVersion: hasPublishedVersion ? 1 : undefined,
      hasUnpublishedChanges: false,
    } as never
  );
  queryClient.setQueryData(
    orpcQuery.workflow.getExecutions.queryKey({
      input: { workflowId: "wf_1", includeSuperseded: false },
    }),
    { items: [], supersededCount: 0, refusedStarts: [] }
  );

  const confirmed: ConfirmRequest[] = [];

  function Rail() {
    const [, setRequest] = useState<ConfirmRequest | null>(null);
    const frame = useMemo<NodeConfigFrame>(
      () => ({
        confirm: (request) => {
          confirmed.push(request);
          setRequest(request);
        },
      }),
      []
    );

    return <NodeConfigPanel frame={frame} />;
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: Record<string, unknown>) => ({
      executionId:
        typeof search.executionId === "string" ? search.executionId : undefined,
    }),
    component: Rail,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/wf_1"] }),
  });

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  return { view, store, confirmed };
}

describe("NodeConfigPanel with nothing selected", () => {
  it("shows an empty state rather than the workflow's settings", async () => {
    const { view } = renderPanel();

    await waitFor(() => {
      expect(view.getByText("Nothing selected")).toBeTruthy();
    });
    expect(
      view.getByText("Select a step on the canvas to configure it.")
    ).toBeTruthy();
  });

  // The name, the id, Clear and Delete Workflow all moved into the menu beside
  // the workflow's name. Two places to rename a workflow is how one of them
  // ends up being the stale one.
  it("offers no workflow-level field or destructive button", async () => {
    const { view, confirmed } = renderPanel();

    await waitFor(() => {
      expect(view.getByText("Nothing selected")).toBeTruthy();
    });

    expect(view.queryByLabelText("Workflow Name")).toBeNull();
    expect(view.queryByLabelText("Workflow ID")).toBeNull();
    expect(view.queryByDisplayValue("Appointment reminders")).toBeNull();
    expect(view.queryByDisplayValue("wf_1")).toBeNull();
    expect(view.queryByRole("button", { name: /Clear/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(confirmed).toEqual([]);
  });
});

describe("NodeConfigPanel config scoping", () => {
  // The panel is keyed to the node, and the pickers inside it are what that
  // buys. Selecting anything of another type unmounts the panel whatever its
  // key, so the case the key answers for is one entry node replaced by another
  // in the same slot, which is what opening a second workflow does. Two of them
  // in one graph is the fixture for that; a real workflow has one.
  it("starts another entry node's pickers clean", async () => {
    const { view, store } = renderPanel({
      nodes: [lifecycleNode(), lifecycleNode("lifecycle_2")],
      selected: "lifecycle_1",
    });

    const picker = await view.findByLabelText("Start Events");
    fireEvent.change(picker, { target: { value: "appoint" } });
    expect((picker as HTMLInputElement).value).toBe("appoint");

    await act(async () => {
      store.set(selectedNodeAtom, "lifecycle_2");
    });

    // Unkeyed, the same component instance carries the search term over and the
    // second node opens on a list filtered by something nobody typed into it.
    expect(
      (view.getByLabelText("Start Events") as HTMLInputElement).value
    ).toBe("");
  });
});

describe("NodeConfigPanel multiple selection", () => {
  it("counts steps and connections together in the selection summary", async () => {
    const first = lifecycleNode("lifecycle_1");
    first.selected = true;
    const second = lifecycleNode("lifecycle_2");
    second.selected = true;
    const connection: WorkflowEdge = {
      id: "edge_1",
      source: "lifecycle_1",
      target: "lifecycle_2",
      selected: true,
    };

    const { view } = renderPanel({
      nodes: [first, second],
      edges: [connection],
    });

    expect(
      await view.findByText("2 steps and 1 connection selected")
    ).toBeTruthy();
  });
});

describe("NodeConfigPanel workspace inspector", () => {
  it("contains no workspace mode tabs", async () => {
    const { view } = renderPanel({ hasPublishedVersion: true });

    await view.findByText("Select a step on the canvas to configure it.");
    expect(view.queryByRole("tablist")).toBeNull();
    expect(view.queryByRole("tab", { name: "Runs" })).toBeNull();
    expect(view.queryByRole("tab", { name: "Changes" })).toBeNull();
  });

  it("follows the active workspace view", async () => {
    const { view, store } = renderPanel({ hasPublishedVersion: true });

    act(() => store.set(workflowWorkspaceViewAtom, "changes"));

    expect(
      await view.findByText(
        "Open a comparison of this draft and its published version."
      )
    ).toBeTruthy();
  });
});

describe("NodeConfigPanel authorization", () => {
  it("does not offer Clear All to a run reader", async () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetExecutions.id,
    ]);
    const { view } = renderPanel({ workspaceView: "runs" });

    await view.findByText("No runs yet");
    expect(view.queryByRole("button", { name: "Clear All" })).toBeNull();
  });

  it("does not add a read-only access badge when workflow updates are denied", async () => {
    resetAuthorizationGrantsForTests();
    const { view } = renderPanel({ selected: "lifecycle_1" });

    await view.findByLabelText("Start Events");
    expect(
      view.queryByText(
        "You are viewing a public workflow. Duplicate it to make changes."
      )
    ).toBeNull();
  });
});
