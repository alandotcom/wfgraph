import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { lifecycleIssueSection } from "#src/components/workflow/canvas-reveal/lifecycle-reveal-model";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { browserTimeZone } from "#src/components/workflow/config/lifecycle-schedule";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  activeRevealPresentationAtom,
  activeWorkspaceAddressAtom,
  openInspectorSectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

const catalog: ExtensionCatalog = {
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [{ path: "status", type: "string" }],
      stateSchemaDigest: "patient-state-v1",
    },
  ],
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "tenantId", type: "string" },
      ],
      entityBindings: [{ name: "patient", entityType: "patient" }],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      correlationPath: "appointment.id",
      payloadFields: [{ path: "appointment.id", type: "string" }],
      entityBindings: [{ name: "patient", entityType: "patient" }],
    },
  ],
  integrations: [],
  actions: [],
};

function condition(field: string, value: string): string {
  return JSON.stringify({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          { id: "rule", field, fieldType: "string", operator: "equals", value },
        ],
      },
    ],
  });
}

const CONFIGURED: LifecycleRules = {
  startEvents: ["app/appointment.created"],
  cancelEvents: ["app/appointment.canceled"],
  concurrency: "newest-wins",
  allowManualStart: false,
  startFilters: { "app/appointment.created": condition("tenantId", "t_1") },
  trackedEntity: {
    type: "patient",
    bindings: {
      "app/appointment.created": "patient",
      "app/appointment.canceled": "patient",
    },
  },
  entityEligibility: {
    condition: condition("status", "active"),
    checkpoints: ["before-execution", "before-node"],
  },
};

function lifecycleNode(rules?: Record<string, unknown>): WorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Appointment lifecycle",
      type: "lifecycle",
      config: rules ? { lifecycleRules: rules } : {},
    },
  };
}

function FakeCanvas() {
  return (
    <div data-testid="workflow-canvas">
      <div className="react-flow__node" data-id="lifecycle" tabIndex={0}>
        Lifecycle card
      </div>
    </div>
  );
}

async function renderLifecycle(
  rules?: Record<string, unknown>,
  options: { extraNodes?: WorkflowNode[] | undefined } = {}
) {
  const nodes = [lifecycleNode(rules), ...(options.extraNodes ?? [])];
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  // The editor's collection pass fills the issue list; the test fills it once
  // from the same collector for the graph it loads.
  store.set(
    workflowIssuesAtom,
    collectWorkflowIssues({
      nodes,
      edges: [],
      catalog,
      integrations: [],
    })
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
        <DetailsPanel />
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
    store.set(selectOnlyNodeAtom, "lifecycle");
  });
  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="details-panel"]');
  // A Browse section is the section element around its heading.
  const region = (name: string) => {
    const section = within(
      view.getByRole("complementary", { name: "Lifecycle inspector" })
    )
      .getByRole("heading", { name })
      .closest("section");
    if (!section) {
      throw new Error(`no Browse section is headed ${name}`);
    }
    return section;
  };
  const scroller = () =>
    aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const rulesNow = () =>
    readLifecycleRules(
      store.get(nodesAtom).find((node) => node.id === "lifecycle")?.data.config
    );
  return { view, store, update, aside, region, scroller, rulesNow };
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

describe("Lifecycle Browse", () => {
  it("summarizes a configured policy with Event filters apart from run matching", async () => {
    const { view, aside, region } = await renderLifecycle(CONFIGURED);

    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("heading", { name: "Appointment lifecycle" })
    ).toBeTruthy();
    expect(aside()?.textContent).toContain("Ready");

    const starts = region("Start Events");
    expect(starts.textContent).toContain("Appointment created");
    expect(starts.textContent).toContain(
      "A Start Filter can limit which arrivals start runs."
    );
    expect(starts.textContent).toContain("t_1");
    expect(starts.textContent).not.toContain("Manual runs");
    expect(starts.textContent).not.toContain("current state");

    const overlapping = region("Overlapping runs");
    expect(overlapping.textContent).toContain("Start the newest run");
    expect(overlapping.textContent).toContain("Manual runsNot allowed");
    const cancels = region("Cancel Events");
    expect(cancels.textContent).toContain("Appointment canceled");
    expect(cancels.textContent).toContain(
      "No Cancel Filter. Every arrival cancels active runs for the Patient ID it provides."
    );

    const eligibility = region("Entity");
    expect(eligibility.textContent).toContain("Each run tracksPatient ID");
    expect(eligibility.textContent).toContain("Before starting and each step");
    expect(eligibility.textContent).toContain(
      "How each Event provides the Patient ID"
    );
    expect(eligibility.textContent).toContain(
      "Appointment createdpatient binding"
    );
    expect(eligibility.textContent).toContain(
      "Appointment canceledpatient binding"
    );
    expect(eligibility.textContent).toContain(
      "Reads the Patient's current state from your app"
    );
    expect(eligibility.textContent).toContain("active");
    expect(eligibility.textContent).not.toContain("Start Filter");

    expect(region("Validation").textContent).toContain("No issues.");
  });

  it("summarizes a partially configured policy", async () => {
    const { region } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      trackedEntity: {
        type: "patient",
        bindings: { "app/appointment.created": "patient" },
      },
    });

    expect(region("Start Events").textContent).toContain(
      "No Start Filter. Every arrival starts a run."
    );
    expect(region("Cancel Events").textContent).toContain("No Cancel Events.");
    const eligibility = region("Entity");
    expect(eligibility.textContent).toContain("No eligibility rule.");
    expect(eligibility.textContent).toContain("None (optional)");
  });

  it("shows a filter shared by every Start Event once", async () => {
    const shared = condition("appointment.id", "a_1");
    const { region } = await renderLifecycle({
      startEvents: ["app/appointment.created", "app/appointment.canceled"],
      cancelEvents: [],
      concurrency: "unlimited",
      startFilters: {
        "app/appointment.created": shared,
        "app/appointment.canceled": shared,
      },
    });

    const starts = region("Start Events").textContent ?? "";
    expect(starts).toContain("One Start Filter for every Event");
    expect(starts.split("a_1")).toHaveLength(2);
  });

  it("shows a node with no rules as the initial policy", async () => {
    const { region } = await renderLifecycle();

    expect(region("Start Events").textContent).toContain("No Start Events.");
    expect(region("Overlapping runs").textContent).toContain(
      "Manual runsAllowed"
    );
    expect(region("Entity").textContent).toContain(
      "No Entity is tracked. Every manual start creates a separate run."
    );
  });

  it("explains Correlation Path matching when an untracked workflow needs it", async () => {
    const { region } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: ["app/appointment.canceled"],
      concurrency: "unlimited",
      correlationPaths: {
        "app/appointment.created": "appointment.id",
        "app/appointment.canceled": "appointment.id",
      },
    });

    expect(region("Entity").textContent).toContain(
      "No Entity is tracked. Lifecycle Events use their Correlation Path values to identify related runs."
    );
  });

  it("reports invalid rules in the header and Validation", async () => {
    const { aside, region } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: ["app/appointment.created"],
      concurrency: "unlimited",
      startFilters: { "app/appointment.created": "not a model" },
    });

    // The rules check refuses the Event holding both roles, and the Start
    // Filter check refuses the model it cannot read.
    expect(aside()?.querySelector("header")?.textContent).toContain("2 issues");
    expect(region("Validation").textContent).toContain(
      "cannot both start and cancel runs"
    );
    expect(region("Start Events").textContent).toContain(
      "This rule is invalid."
    );
  });

  // ADR-0016: such a filter reads false on every arrival, and Publish refuses
  // it, so the editor shows the same refusal before Publish is tried.
  it("reports a Start Filter reading an undeclared path as blocking, and opens its section", async () => {
    const { view, aside, region } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      startFilters: {
        "app/appointment.created": condition("clinicId", "c_1"),
      },
    });

    const status = within(
      aside()?.querySelector("header") ?? document.body
    ).getByText("1 issue");
    expect(status.className).toContain("text-destructive");
    const issue = within(region("Validation")).getByRole("button", {
      name: /clinicId/,
    });
    expect(issue.className).toContain("text-destructive");

    fireEvent.click(issue);

    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("button", { name: "Done editing Start Events" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("lifecycle-section-start-events")
    );
  });

  it("summarizes each schedule with its next run", async () => {
    // Friday Nov 6, 2026, 7:00 AM in New York.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    try {
      const { region } = await renderLifecycle({
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        schedules: [{ cron: "0 9 * * 1-5", timeZone: "America/New_York" }],
      });

      expect(region("Schedule").textContent).toContain(
        "Every weekday at 9:00 AM (America/New_York)Next run: Fri Nov 6, 9:00 AM"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a workflow has no schedules", async () => {
    const { region } = await renderLifecycle(CONFIGURED);
    expect(region("Schedule").textContent).toContain("No schedules.");
  });

  it("marks Events and an Entity the catalog no longer declares", async () => {
    const { region } = await renderLifecycle({
      startEvents: ["app/retired.event"],
      cancelEvents: [],
      concurrency: "unlimited",
      trackedEntity: {
        type: "retired-entity",
        bindings: { "app/retired.event": "gone" },
      },
    });

    expect(region("Start Events").textContent).toContain(
      "app/retired.event · Not declared by this app"
    );
    expect(region("Entity").textContent).toContain(
      "retired-entity is no longer available in this app."
    );
    expect(region("Validation").textContent).toContain("app/retired.event");
  });
});

describe("Lifecycle section editors", () => {
  it("opens a section's editor in place, in the policy's order", async () => {
    const { view } = await renderLifecycle(CONFIGURED);
    const headings = () =>
      within(view.getByRole("complementary", { name: "Lifecycle inspector" }))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent);
    const order = [
      "Label",
      "Start Events",
      "Overlapping runs",
      "Schedule",
      "Cancel Events",
      "Entity",
      "Event Connections",
      "Validation",
    ];
    expect(headings()).toEqual(order);
    expect(view.queryByRole("button", { name: "Focus editor" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Edit Start Events" }));

    // The open editor adds headings of its own inside its section.
    expect(headings().filter((text) => order.includes(text ?? ""))).toEqual(
      order
    );
    expect(view.getByRole("region", { name: "Start Events" })).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Done editing Start Events" })
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Edit Start Events" })
    ).toBeNull();
  });

  it("keeps Event bindings and eligibility timing in the Entity section", async () => {
    const { view } = await renderLifecycle(CONFIGURED);
    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));

    const entity = view.getByRole("region", { name: "Entity" });
    expect(entity.textContent).toContain("Patient ID in each Event");
    expect(entity.textContent).toContain("Appointment created");
    expect(entity.textContent).toContain(
      "Uses the patient binding to get the Patient ID."
    );
    expect(within(entity).getByText("When to check")).toBeTruthy();
    expect(
      within(entity).getByRole("checkbox", { name: "Before each step" })
    ).toBeTruthy();
    expect(
      within(entity)
        .getByRole("button", { name: "Remove tracking and eligibility" })
        .className.includes("border-border")
    ).toBe(true);
    expect(
      view.queryByRole("button", { name: "Eligibility checks" })
    ).toBeNull();
  });

  it("explains why tracked Entity Events have no Correlation Path", async () => {
    const { view } = await renderLifecycle(CONFIGURED);
    fireEvent.click(view.getByRole("button", { name: "Edit Cancel Events" }));

    const cancelEvents = view.getByRole("region", { name: "Cancel Events" });
    expect(cancelEvents.textContent).toContain(
      "Each Event's Patient binding provides its Patient ID. A Cancel Event only affects active runs with the same ID. Correlation Paths are not used."
    );
    expect(within(cancelEvents).queryByText("Correlation Path")).toBeNull();
  });

  it("writes an edit through the graph store and autosaves it", async () => {
    const { view, update, rulesNow } = await renderLifecycle(CONFIGURED);
    fireEvent.click(
      view.getByRole("button", { name: "Edit Overlapping runs" })
    );

    fireEvent.click(view.getByRole("checkbox", { name: "Allow manual runs" }));

    expect(rulesNow()?.allowManualStart).toBe(true);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("keeps removing a Start Event undoable and prunes its filter", async () => {
    const { view, store, rulesNow } = await renderLifecycle(CONFIGURED);
    fireEvent.click(view.getByRole("button", { name: "Edit Start Events" }));

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    expect(rulesNow()?.startEvents).toEqual([]);
    expect(rulesNow()?.startFilters).toBeUndefined();
    expect(store.get(historyAtom)).toHaveLength(1);
  });

  it("opens a later section after another step in one navigation write", async () => {
    const step: WorkflowNode = {
      id: "step",
      type: "action",
      position: { x: 0, y: 200 },
      data: { label: "Step", type: "action", config: {} },
    };
    const { view, store, aside } = await renderLifecycle(CONFIGURED, {
      extraNodes: [step],
    });
    await act(async () => {
      store.set(selectOnlyNodeAtom, "step");
    });
    await act(async () => {
      store.set(clearSelectionAtom);
    });
    expect(
      view.queryByRole("complementary", { name: "Lifecycle inspector" })
    ).toBeNull();

    await act(async () => {
      store.set(openInspectorSectionAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        nodeId: "lifecycle",
        section: "cancel-events",
      });
    });

    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("button", { name: "Done editing Cancel Events" })
    ).toBeTruthy();
    expect(view.getByRole("region", { name: "Cancel Events" })).toBeTruthy();
  });

  it("returns to the Event Split that opened it on Back", async () => {
    const split: WorkflowNode = {
      id: "split",
      type: "action",
      position: { x: 0, y: 200 },
      data: {
        label: "Split",
        type: "action",
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      },
    };
    const { view, store, aside } = await renderLifecycle(CONFIGURED, {
      extraNodes: [split],
    });

    await act(async () => {
      store.set(openInspectorSectionAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        nodeId: "lifecycle",
        section: "start-events",
        origin: { nodeId: "split" },
      });
    });
    expect(aside()?.dataset.level).toBe("browse");

    fireEvent.click(view.getByRole("button", { name: "Back" }));

    // Back returns to the Event Split: the active address now inspects the
    // Event Split, at the level its own Browse-only kind clamps to.
    expect(store.get(activeRevealPresentationAtom).inspected).toEqual({
      kind: "node",
      id: "split",
    });
    expect(aside()?.dataset.level).toBe("browse");
  });

  it("offers no Back without an origin, and Escape closes the open section first", async () => {
    const { view, aside } = await renderLifecycle(CONFIGURED);
    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(
      view.queryByRole("button", { name: "Done editing Entity" })
    ).toBeNull();
    expect(aside()?.dataset.level).toBe("browse");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Edit Entity" })
      )
    );

    // With no section open and no way back, Escape keeps the Lifecycle Node
    // shown.
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(
      view.getByRole("complementary", { name: "Lifecycle inspector" })
    ).toBeTruthy();
  });

  it("restores the section and scroll after another step and back", async () => {
    const { view, store, scroller } = await renderLifecycle(CONFIGURED);
    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));

    const body = scroller();
    if (!body) {
      throw new Error("the Lifecycle inspector did not render");
    }
    body.scrollTop = 180;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));

    const positions = store.get(nodesAtom).map((node) => node.position);

    await act(async () => {
      showWorkspaceRoute(store, { view: "runs" });
    });
    await act(async () => {
      showWorkspaceRoute(store, {});
    });
    expect(view.getByRole("region", { name: "Entity" })).toBeTruthy();
    await waitFor(() => expect(scroller()?.scrollTop).toBe(180));

    expect(store.get(nodesAtom).map((node) => node.position)).toEqual(
      positions
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("moves focus to an opened section's heading, and to its Edit button on Done", async () => {
    const { view, store } = await renderLifecycle(CONFIGURED);
    const positions = store.get(nodesAtom).map((node) => node.position);

    fireEvent.click(view.getByRole("button", { name: "Edit Schedule" }));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("lifecycle-section-schedule")
    );

    fireEvent.click(
      view.getByRole("button", { name: "Done editing Schedule" })
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Edit Schedule" })
      )
    );
    expect(store.get(nodesAtom).map((node) => node.position)).toEqual(
      positions
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("explains the Entity and Event Connections of a policy that needs neither", async () => {
    const { view } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
    });
    expect(
      within(
        view.getByRole("complementary", { name: "Lifecycle inspector" })
      ).getByText("No integration Events, so no Connection is needed.")
    ).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "Edit Event Connections" })
    );
    expect(
      view.getByRole("region", { name: "Event Connections" }).textContent
    ).toContain("need a Connection");

    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));
    const entity = view.getByRole("region", { name: "Entity" });
    expect(entity.textContent).toContain(
      "Optional. Track an Entity to match related runs by Entity ID."
    );
    expect(within(entity).queryByText("When to check")).toBeNull();
  });

  it("shows timing controls beside an empty eligibility checkpoint error", async () => {
    const { view } = await renderLifecycle({
      ...CONFIGURED,
      entityEligibility: {
        condition: condition("status", "active"),
        checkpoints: [],
      },
    });
    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));

    const eligibility = view.getByRole("region", {
      name: "Entity",
    });
    expect(within(eligibility).getByRole("alert").textContent).toContain(
      "has no checkpoint"
    );
    expect(within(eligibility).getByText("When to check")).toBeTruthy();
    expect(
      within(eligibility).getByRole("checkbox", {
        name: "Before starting a run",
      })
    ).toBeTruthy();
  });

  it("adds a schedule from the Schedule section as one undoable edit", async () => {
    const { view, store, rulesNow } = await renderLifecycle({
      ...CONFIGURED,
      trackedEntity: undefined,
      entityEligibility: undefined,
    });
    fireEvent.click(view.getByRole("button", { name: "Edit Schedule" }));

    const section = view.getByRole("region", { name: "Schedule" });
    fireEvent.click(
      within(section).getByRole("button", { name: "Add schedule" })
    );

    expect(rulesNow()?.schedules).toEqual([
      { cron: "0 9 * * *", timeZone: browserTimeZone() },
    ]);
    expect(store.get(historyAtom)).toHaveLength(1);
    fireEvent.click(
      view.getByRole("button", { name: "Done editing Schedule" })
    );
    expect(view.queryByText("No schedules.")).toBeNull();
  });

  it("shows an unsaved schedule's refusal inside the Schedule section", async () => {
    const { view, rulesNow } = await renderLifecycle({
      ...CONFIGURED,
      trackedEntity: undefined,
      entityEligibility: undefined,
      schedules: [{ cron: "0 9 * * *", timeZone: browserTimeZone() }],
    });
    fireEvent.click(view.getByRole("button", { name: "Edit Schedule" }));

    const section = view.getByRole("region", { name: "Schedule" });
    fireEvent.click(
      within(section).getByRole("button", { name: "Add schedule" })
    );

    expect(section.textContent).toContain(
      "Two schedules have the same cron expression and time zone."
    );
    expect(rulesNow()?.schedules).toHaveLength(1);
  });

  it("shows the unavailable Entity warning from the reused editor", async () => {
    const { view } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      trackedEntity: {
        type: "retired-entity",
        bindings: { "app/appointment.created": "patient" },
      },
    });
    fireEvent.click(view.getByRole("button", { name: "Edit Entity" }));

    expect(
      within(view.getByRole("region", { name: "Entity" })).getByRole("alert")
        .textContent
    ).toContain("retired-entity is no longer available");
  });
});

describe("lifecycleIssueSection", () => {
  it("opens the Schedule section for a schedule Publish refuses", () => {
    expect(
      lifecycleIssueSection({
        kind: "invalid_lifecycle_rules",
        severity: "blocking",
        nodeId: "lifecycle",
        nodeLabel: "Appointment lifecycle",
        check: "schedule",
        message: "A scheduled run carries no Event.",
      })
    ).toBe("schedule");
  });
});
