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
import { describe, expect, it } from "vitest";
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
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { orpcQuery } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

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

  selected = null,
  isOwner = true,
  hasPublishedVersion = false,
}: {
  nodes?: WorkflowNode[];
  selected?: string | null;
  isOwner?: boolean;
  hasPublishedVersion?: boolean;
} = {}) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  store.set(selectedNodeAtom, selected);
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  store.set(isWorkflowOwnerAtom, isOwner);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

  // A non-owner reached this branch for the read-only notice, and the branch it
  // reached it through is gone. The notice is not.
  it("keeps the read-only notice for a non-owner", async () => {
    const { view } = renderPanel({ isOwner: false });

    await waitFor(() => {
      expect(view.getByText(/You are viewing a public workflow/)).toBeTruthy();
    });
  });
});

describe("NodeConfigPanel config scoping", () => {
  // The Lifecycle panel holds one view/edit mode, and that mode belongs to the
  // node being configured rather than to the panel. Selecting anything of
  // another type unmounts the panel whatever its key, so the case the key
  // answers for is one entry node replaced by another in the same slot -- which
  // is what opening a second workflow does. Two of them in one graph is the
  // fixture for that; a real workflow has one.
  it("starts another entry node's configuration on view", async () => {
    const { view, store } = renderPanel({
      nodes: [lifecycleNode(), lifecycleNode("lifecycle_2")],
      selected: "lifecycle_1",
    });

    await waitFor(() => {
      expect(
        view.getByRole("button", { name: "Edit Lifecycle Rules" })
      ).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Edit Lifecycle Rules" }));
    expect(view.getByLabelText("Start Events")).toBeTruthy();

    await act(async () => {
      store.set(selectedNodeAtom, "lifecycle_2");
    });

    // Unkeyed, the same component instance carries the open section over and
    // the second node opens on controls its builder never asked for.
    expect(view.queryByLabelText("Start Events")).toBeNull();
    expect(
      view.getByRole("button", { name: "Edit Lifecycle Rules" })
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
