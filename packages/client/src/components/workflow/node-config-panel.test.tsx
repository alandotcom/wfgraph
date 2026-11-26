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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  type ConfirmRequest,
  deleteAllRunsPrompt,
  type NodeConfigFrame,
  NodeConfigPanel,
  RunsListActions,
} from "#src/components/workflow/node-config-panel";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  successfulSaveGenerationAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  savedWorkflow,
  unreadableDraft,
} from "#src/lib/workflow-save-test-support";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import type { workflowApi } from "#src/lib/rpc-client";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      description: "Raised when an appointment is created.",
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

/** A Wait step, whose fields the action config renders from its actionType. */
function waitNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "wait_1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    },
  };
}

function eventSplitNode(): WorkflowNode {
  return {
    id: "split_1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Event Split",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
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
 * The panel in the Inspector's frame, over a router and a query client because the
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
  extensionCatalog = catalog,
  autosaveDelay = 0,
  update = async () => savedWorkflow("wf_1"),
}: {
  extensionCatalog?: ExtensionCatalog;
  autosaveDelay?: number;
  update?: (typeof workflowApi)["update"];
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  selected?: string | null;
  hasPublishedVersion?: boolean;
  workspaceView?: "draft" | "runs";
} = {}) {
  const store = createStore();
  store.set(autosaveDelayAtom, autosaveDelay);
  store.set(workflowApiAtom, { update, read: unreadableDraft });
  store.set(loadWorkflowGraphAtom, { nodes, edges });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(
    store,
    workspaceView === "draft" ? {} : { view: workspaceView }
  );
  if (selected !== null) {
    store.set(selectOnlyNodeAtom, selected);
  }
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
    {
      items: [],
      observedAt: "2026-03-01T10:00:00.000Z",
      overdueAfterMs: 60_000,
      runRetentionMs: null,
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    }
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
    <ExtensionCatalogProvider value={extensionCatalog}>
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
  it("puts what the step does before its Label and Notes", async () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    const { view } = renderPanel({
      nodes: [lifecycleNode(), waitNode({ waitMode: "delay" })],
      selected: "wait_1",
    });

    const label = await view.findByLabelText("Label");
    const notes = view.getByLabelText("Notes");
    const does = view.getByLabelText("Does");

    expect(view.queryByText("Node Metadata")).toBeNull();
    expect(
      does.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      label.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Disabling and deleting the step are the menus' commands.
    expect(view.queryByRole("button", { name: /Disable step/ })).toBeNull();
    expect(view.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(view.queryByText("Validation")).toBeNull();
  });

  it("shows an Event's description and raw name in Event Split config", async () => {
    const split = eventSplitNode();
    const { view } = renderPanel({
      nodes: [lifecycleNode(), split],
      edges: [
        {
          id: "lifecycle-split",
          source: "lifecycle_1",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
          target: split.id,
        },
      ],
      selected: split.id,
    });

    expect(await view.findByText("Appointment created")).toBeTruthy();
    expect(
      view.getByText("Raised when an appointment is created.")
    ).toBeTruthy();
    expect(view.getByText("app/appointment.created")).toBeTruthy();
  });
});

describe("NodeConfigPanel connection", () => {
  it("names a connection by its steps and deletes it at once", async () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    const connection: WorkflowEdge = {
      id: "edge_1",
      source: "lifecycle_1",
      target: "lifecycle_2",
    };
    const first = lifecycleNode("lifecycle_1");
    const second = lifecycleNode("lifecycle_2");
    const { view, store, confirmed } = renderPanel({
      nodes: [
        { ...first, data: { ...first.data, label: "Start" } },
        { ...second, data: { ...second.data, label: "Finish" } },
      ],
      edges: [connection],
    });
    act(() =>
      store.set(activeSelectionAtom, { nodeIds: [], edgeIds: ["edge_1"] })
    );

    expect(await view.findByText("Start")).toBeTruthy();
    expect(view.getByText("Finish")).toBeTruthy();
    expect(view.queryByText("edge_1")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    expect(confirmed).toEqual([]);
    expect(store.get(edgesAtom)).toEqual([]);
  });
});

describe("NodeConfigPanel multiple selection", () => {
  it("counts steps and connections together in the selection summary", async () => {
    const connection: WorkflowEdge = {
      id: "edge_1",
      source: "lifecycle_1",
      target: "lifecycle_2",
    };

    const { view, store } = renderPanel({
      nodes: [lifecycleNode("lifecycle_1"), lifecycleNode("lifecycle_2")],
      edges: [connection],
    });
    act(() =>
      store.set(activeSelectionAtom, {
        nodeIds: ["lifecycle_1", "lifecycle_2"],
        edgeIds: ["edge_1"],
      })
    );

    expect(
      await view.findByText("2 steps and 1 connection selected")
    ).toBeTruthy();
  });

  it("counts a selected frame as a Group the delete ungroups", async () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    const member = (id: string): WorkflowNode => ({
      id,
      type: "action",
      parentId: "group_1",
      extent: "parent",
      position: { x: 0, y: 0 },
      data: {
        label: id,
        type: "action",
        config: { actionType: "fountain/get-user" },
      },
    });

    const { view, store, confirmed } = renderPanel({
      nodes: [groupNode(), member("a"), member("b")],
    });
    act(() =>
      store.set(activeSelectionAtom, {
        nodeIds: ["group_1", "a"],
        edgeIds: [],
      })
    );

    expect(await view.findByText("1 step and 1 Group selected")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Delete/ }));

    expect(confirmed.map((request) => request.message)).toEqual([
      "Are you sure you want to delete 1 step? The selected Group is ungrouped, and the steps inside that are not selected stay in the workflow.",
    ]);
  });
});

describe("NodeConfigPanel workspace inspector", () => {
  it("contains no workspace mode tabs", async () => {
    const { view } = renderPanel({ hasPublishedVersion: true });

    await view.findByText("Select a step on the canvas to configure it.");
    expect(view.queryByRole("tablist")).toBeNull();
    expect(view.queryByRole("tab", { name: "Runs" })).toBeNull();
  });

  it("follows the active workspace view, and leaves Runs to its own inspector", async () => {
    const { view, store } = renderPanel({ hasPublishedVersion: true });
    await view.findByText("Select a step on the canvas to configure it.");

    act(() => showWorkspaceRoute(store, { view: "runs" }));
    expect(view.getByTestId("properties-panel").textContent).toBe("");

    act(() => showWorkspaceRoute(store, {}));
    expect(
      await view.findByText("Select a step on the canvas to configure it.")
    ).toBeTruthy();
  });
});

describe("NodeConfigPanel authorization", () => {
  it("does not add a read-only access badge when workflow updates are denied", async () => {
    resetAuthorizationGrantsForTests();
    const { view } = renderPanel({
      nodes: [lifecycleNode(), waitNode({ waitMode: "delay" })],
      selected: "wait_1",
    });

    await view.findByLabelText("Label");
    expect(
      view.queryByText(
        "You are viewing a public workflow. Duplicate it to make changes."
      )
    ).toBeNull();
  });
});

/**
 * Leaving a Wait shape drops the value keys that shape owned, so a run never
 * reads a duration or a timeout the node is no longer in the shape for.
 */
describe("NodeConfigPanel Wait mode", () => {
  function renderWaitPanel(config: Record<string, unknown>) {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
    return renderPanel({
      nodes: [lifecycleNode(), waitNode(config)],
      selected: "wait_1",
    });
  }

  it("puts time-based wait guidance beside the control it explains", async () => {
    const { view } = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "1h",
    });

    expect(
      view.queryByText(/starts counting when the run reaches this step/i)
    ).toBeNull();

    fireEvent.click(
      await view.findByRole("button", { name: "About Duration" })
    );
    expect(
      await view.findByText(/Counting starts when the run reaches this step/i)
    ).toBeTruthy();

    // A 1-hour Wait sets nothing else, so its other options start closed.
    expect(
      view.queryByRole("button", {
        name: "About If the scheduled time has passed",
      })
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "More options" }));

    fireEvent.click(
      view.getByRole("button", {
        name: "About If the scheduled time has passed",
      })
    );
    expect(
      await view.findByText(/scheduled time has passed, continue immediately/i)
    ).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "About Timezone (optional)" })
    );
    expect(
      await view.findByText(/Sets the clock for Allowed hours/i)
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "About Time source" }));
    expect(
      await view.findByText(/Changing the Time source clears settings/)
    ).toBeTruthy();
  });

  it("opens a Wait on its one choice, with More options open only when one is set", async () => {
    const plain = renderWaitPanel({ waitMode: "delay", waitDuration: "1d" });
    expect(
      (
        await plain.view.findByRole("button", { name: "More options" })
      ).getAttribute("aria-expanded")
    ).toBe("false");
    expect(plain.view.queryByLabelText(/Timezone/)).toBeNull();
    plain.view.unmount();

    const windowed = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "1d",
      waitAllowedHoursMode: "daily_window",
    });
    expect(
      (
        await windowed.view.findByRole("button", { name: "More options" })
      ).getAttribute("aria-expanded")
    ).toBe("true");
    windowed.view.unmount();

    // Event mode writes its default timeout, which counts as unset.
    const event = renderWaitPanel({ waitMode: "event", waitTimeout: "7d" });
    await event.view.findByRole("button", { name: "More options" });
    expect(event.view.queryByText("Stop waiting after")).toBeNull();
    fireEvent.click(
      await event.view.findByRole("button", { name: "More options" })
    );
    expect(event.view.getByText("Stop waiting after")).toBeTruthy();
  });

  it("marks a Duration that cannot be read and leaves a readable one alone", async () => {
    const unreadable = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "banana5s",
    });
    const field = await unreadable.view.findByRole("textbox", {
      name: "Duration",
    });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    unreadable.view.unmount();

    const readable = renderWaitPanel({ waitMode: "delay", waitDuration: "1h" });
    expect(
      (
        await readable.view.findByRole("textbox", { name: "Duration" })
      ).getAttribute("aria-invalid")
    ).toBeNull();
  });

  it("offers common durations and reads the typed one back in words", async () => {
    const { view } = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "24h",
    });

    const oneDay = await view.findByRole("button", { name: "1 day" });
    expect(oneDay.getAttribute("aria-pressed")).toBe("true");
    expect(view.getByText("Waits 1 day.")).toBeTruthy();
    expect(
      (await view.findByRole("textbox", { name: "Duration" })).getAttribute(
        "aria-describedby"
      )
    ).toBe("waitDuration-readback");

    fireEvent.click(view.getByRole("button", { name: "1 week" }));
    expect(await view.findByText("Waits 1 week.")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "1 week" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(oneDay.getAttribute("aria-pressed")).toBe("false");
  });

  it("says how to write a Duration it cannot read", async () => {
    const { view } = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "one day",
    });

    expect(
      await view.findByText(
        "This step cannot read that length. Type it as 1d, 24h or 90m."
      )
    ).toBeTruthy();
  });

  it("uses the default past-time help for an unknown stored option", async () => {
    const { view } = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "1h",
      waitGateMode: "future-option",
    });

    fireEvent.click(
      await view.findByRole("button", {
        name: "About If the scheduled time has passed",
      })
    );
    expect(
      await view.findByText(/scheduled time has passed, continue immediately/i)
    ).toBeTruthy();
  });

  it("puts scheduled-time and allowed-hours help beside those controls", async () => {
    const { view } = renderWaitPanel({
      waitMode: "delay",
      waitDelayTimingMode: "until",
      waitUntil: "2026-03-10T09:00:00-05:00",
      waitOffset: "-1d",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
      waitTimezone: "America/New_York",
    });

    fireEvent.click(
      await view.findByRole("button", { name: "About Date and time" })
    );
    expect(
      await view.findByText(/choose a value from Event or step data/i)
    ).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "About Adjust time (optional)" })
    );
    expect(
      await view.findByText(/Move the scheduled time earlier/)
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "About Allowed hours" }));
    expect(await view.findByText(/moves to the next Start time/)).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", {
        name: "About Timezone (required for allowed hours)",
      })
    );
    expect(
      await view.findByText(/Sets the clock for Allowed hours/i)
    ).toBeTruthy();
  });

  it("keeps Event wait behavior in contextual help", async () => {
    const { view } = renderWaitPanel({
      waitMode: "event",
      waitFor: [],
      waitTimeout: "1h",
    });

    const helpButton = await view.findByRole("button", {
      name: "About How should this step wait?",
    });
    expect(view.queryByText(/With no match, any arrival/)).toBeNull();

    fireEvent.click(helpButton);

    await waitFor(() => {
      expect(view.getByText(/With no match, any arrival/)).toBeTruthy();
    });
    expect(view.getByText(/cannot wait forever/)).toBeTruthy();
  });

  it("shows maximum lateness only for its gate and clears it when leaving", async () => {
    const { view, store } = renderWaitPanel({
      waitMode: "delay",
      waitDuration: "1h",
      waitGateMode: "max_lateness",
      waitMaxLateness: "6h",
    });

    expect(
      await view.findByRole("textbox", { name: "Continue if late by up to" })
    ).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", {
        name: "About If the scheduled time has passed",
      })
    );
    expect(await view.findByText(/within the allowed lateness/i)).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", { name: "About Continue if late by up to" })
    );
    expect(
      await view.findByText(/checked before Allowed hours adjust/i)
    ).toBeTruthy();

    const picker = view.getByRole("combobox", {
      name: "If the scheduled time has passed",
    });
    fireEvent.click(picker);
    const choice = view.getByRole("option", { name: "Continue immediately" });
    fireEvent.pointerDown(choice);
    fireEvent.click(choice);

    expect(
      view.queryByRole("textbox", { name: "Continue if late by up to" })
    ).toBeNull();
    const stored = store.get(nodesAtom).find((node) => node.id === "wait_1");
    expect(stored?.data.config?.waitGateMode).toBe("off");
    expect(stored?.data.config?.waitMaxLateness).toBe("");
  });

  it("clears the timeout when the step leaves event mode", async () => {
    const { view, store } = renderWaitPanel({
      waitMode: "event",
      waitTimeout: "1h",
    });

    const picker = await view.findByRole("combobox", {
      name: "How should this step wait?",
    });
    fireEvent.click(picker);
    const choice = view.getByRole("option", { name: "Wait for time" });
    fireEvent.pointerDown(choice);
    fireEvent.click(choice);

    const stored = store.get(nodesAtom).find((node) => node.id === "wait_1");
    expect(stored?.data.config?.waitMode).toBe("delay");
    expect(stored?.data.config?.waitTimeout).toBe("");
    await waitFor(() => {
      expect(store.get(successfulSaveGenerationAtom).get("wf_1")).toBe(1);
    });
  });
});

describe("NodeConfigPanel Action Links", () => {
  const linkCatalog: ExtensionCatalog = {
    ...catalog,
    actions: [
      {
        id: "members/send-email",
        label: "Send Email to Member",
        description: "Sends an email",
        category: "Members",
        links: [
          {
            label: "Preview email",
            url: "/email-preview?workflow={workflowId}&node={nodeId}",
          },
        ],
        configFields: [{ key: "subject", label: "Subject", type: "text" }],
        outputFields: [],
      },
    ],
  };

  function emailNode(): WorkflowNode {
    return {
      id: "send_1",
      type: "action",
      position: { x: 0, y: 100 },
      data: {
        label: "Welcome email",
        type: "action",
        config: { actionType: "members/send-email", subject: "Hello" },
      },
    };
  }

  // The edit lands on the autosave timer, and the link's click is what sends
  // it, so the host's page reads the subject the builder just typed.
  it("sends the field edit the builder just made when the link is clicked", async () => {
    const update = vi.fn(async () => savedWorkflow("wf_1"));
    const { view } = renderPanel({
      nodes: [lifecycleNode(), emailNode()],
      selected: "send_1",
      extensionCatalog: linkCatalog,
      autosaveDelay: 60_000,
      update,
    });

    const link = await view.findByRole("link", { name: "Preview email" });
    fireEvent.change(view.getByLabelText("Subject"), {
      target: { value: "Welcome aboard" },
    });
    expect(update).not.toHaveBeenCalled();

    // The document prevents the navigation, so happy-dom opens no window.
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("click", stop);
    fireEvent.click(link);
    document.removeEventListener("click", stop);

    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(JSON.stringify(update.mock.calls[0])).toContain("Welcome aboard");
  });
});

describe("RunsListActions", () => {
  function renderActions(statuses: string[]) {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowDeleteExecutions.id,
    ]);
    const store = createStore();
    store.set(currentWorkflowIdAtom, "wf_1");
    showWorkspaceRoute(store, { view: "runs" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      orpcQuery.workflow.getExecutions.queryKey({
        input: { workflowId: "wf_1", includeSuperseded: false },
      }),
      {
        items: statuses.map((status, index) => ({
          id: `run_${index}`,
          status,
        })),
        supersededCount: 2,
      } as never
    );
    const confirmed: ConfirmRequest[] = [];
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const workflowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/$workflowId",
      component: () => (
        <RunsListActions confirm={(request) => confirmed.push(request)} />
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([workflowRoute]),
      history: createMemoryHistory({
        initialEntries: ["/workflows/wf_1?view=runs"],
      }),
    });
    const view = render(
      <ExtensionCatalogProvider value={catalog}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <RouterProvider router={router} />
          </JotaiProvider>
        </QueryClientProvider>
      </ExtensionCatalogProvider>
    );
    return { view, confirmed };
  }

  it("names the control Delete all runs and asks with the count before deleting", async () => {
    const { view, confirmed } = renderActions(["running", "success"]);

    fireEvent.click(
      await view.findByRole("button", { name: "Delete all runs" })
    );

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      title: "Delete 4 runs?",
      message:
        "This deletes every run of this workflow and its history, 4 runs in all. Deleting stops 1 run that is still active. This cannot be undone.",
      confirmLabel: "Delete 4 runs",
    });
  });
});

describe("deleteAllRunsPrompt", () => {
  it("names no count before the run list has been read", () => {
    expect(deleteAllRunsPrompt(undefined)).toEqual({
      title: "Delete all runs?",
      message:
        "This deletes every run of this workflow and its history. Deleting stops any run that is still active. This cannot be undone.",
      confirmLabel: "Delete all runs",
    });
  });

  it("states an exact count with no active sentence when every run has ended", () => {
    expect(
      deleteAllRunsPrompt({ statuses: ["success"], hiddenSupersededCount: 0 })
    ).toEqual({
      title: "Delete 1 run?",
      message:
        "This deletes every run of this workflow and its history, 1 run in all. This cannot be undone.",
      confirmLabel: "Delete 1 run",
    });
  });

  // The list returns at most its newest 50 runs, so a full list is a floor.
  it("states a floor when the list is full", () => {
    const statuses = [
      "waiting",
      "running",
      ...Array.from({ length: 48 }, () => "success"),
    ];
    expect(deleteAllRunsPrompt({ statuses, hiddenSupersededCount: 3 })).toEqual(
      {
        title: "Delete 53 or more runs?",
        message:
          "This deletes every run of this workflow and its history, 53 or more runs in all. Deleting stops at least 2 runs that are still active. This cannot be undone.",
        confirmLabel: "Delete all runs",
      }
    );
  });
});
