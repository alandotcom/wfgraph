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
import {
  LIFECYCLE_ADD_RULE_ID,
  lifecycleIssueSection,
  lifecycleRuleTargetId,
} from "#src/components/workflow/canvas-reveal/lifecycle-reveal-model";
import { revealFieldRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { browserTimeZone } from "#src/components/workflow/config/lifecycle-schedule";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
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
  openNodeRevealFromOriginAtom,
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
  // A rule is the section element around its label.
  const region = (name: string) => {
    const section = within(
      view.getByRole("complementary", { name: "Start details" })
    )
      .getByRole("heading", { name })
      .closest("section");
    if (!section) {
      throw new Error(`no rule is labelled ${name}`);
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

/** The help behind the info icon beside the label `name`, opened. */
function openHelp(view: ReturnType<typeof render>, name: string): HTMLElement {
  fireEvent.click(view.getByRole("button", { name: `About ${name}` }));
  return view.getByRole("dialog", { name });
}

/** Chooses `label` from the start's "Add a rule" menu. */
function addRule(view: ReturnType<typeof render>, label: string) {
  const trigger = view.getByRole("button", { name: "Add a rule" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyUp(trigger, { key: "ArrowDown" });
  fireEvent.click(view.getByRole("menuitem", { name: label }));
}

/** The rules the start's "Add a rule" menu offers, in order. */
function offeredRules(view: ReturnType<typeof render>): string[] {
  const trigger = view.getByRole("button", { name: "Add a rule" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyUp(trigger, { key: "ArrowDown" });
  const items = view
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
  fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
  return items;
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

describe("Lifecycle form", () => {
  it("shows each set rule as its controls under one label, with no Edit or Done", async () => {
    const { view, aside } = await renderLifecycle(CONFIGURED);

    expect(aside()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("heading", { name: "Appointment lifecycle" })
    ).toBeTruthy();
    expect(aside()?.textContent).toContain("Ready");
    expect(
      within(view.getByRole("complementary", { name: "Start details" }))
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent)
    ).toEqual([
      "Starts when",
      "One run per",
      "If a run is already in progress",
      "Stop a run when",
    ]);
    expect(
      view.getByRole("heading", { name: "Only while the patient matches" })
    ).toBeTruthy();
    expect(view.getByLabelText("Starts when")).toBeTruthy();
    expect(
      (
        view.getByRole("checkbox", {
          name: "Can be run by hand",
        }) as HTMLButtonElement
      ).getAttribute("aria-checked")
    ).toBe("false");
    expect(
      view.getByRole("combobox", { name: "If a run is already in progress" })
        .textContent
    ).toContain("Start the newest run");
    expect(view.getByLabelText("Label")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(view.queryByRole("button", { name: /^Done/ })).toBeNull();
    expect(
      view.queryByRole("button", { name: "Choose what starts it" })
    ).toBeNull();
  });

  it("moves explanations behind the info icon on each label", async () => {
    const { view, region } = await renderLifecycle(CONFIGURED);

    const identity =
      "Each Event's Patient binding provides the Patient ID tracked by the run. Correlation Paths are not used.";
    expect(region("Starts when").textContent).not.toContain(identity);
    expect(openHelp(view, "Starts when").textContent).toContain(identity);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(
      openHelp(view, "If a run is already in progress").textContent
    ).toContain(
      "A newer Appointment created for the same Patient ends the run in progress."
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(openHelp(view, "One run per").textContent).toContain(
      "Appointment created uses the patient binding to get the Patient ID."
    );
  });

  it("shows a node with no rules as what starts it and Add a rule", async () => {
    const { view } = await renderLifecycle();

    expect(
      within(view.getByRole("complementary", { name: "Start details" }))
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent)
    ).toEqual(["Starts when"]);
    expect(
      view.getByRole("checkbox", { name: "Can be run by hand" })
    ).toBeTruthy();
    // "Only start when…" waits for a Start Event to filter.
    expect(offeredRules(view)).toEqual([
      "Stop a run when…",
      "If a run is already in progress…",
      "On a schedule…",
      "One run per…",
      "Only while the record matches…",
    ]);
  });

  it("hides the rules a workflow has not set, and offers them under Add a rule", async () => {
    const { view } = await renderLifecycle(CONFIGURED);
    expect(view.queryByRole("heading", { name: "On a schedule" })).toBeNull();
    expect(offeredRules(view)).toEqual(["On a schedule…"]);
  });

  it("adds a rule's controls in place and moves focus into them without writing", async () => {
    const { view, store, scroller } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
    });
    // No Event arrives through an integration, so no Connection is asked for.
    expect(
      view.queryByRole("heading", { name: "Event Connections" })
    ).toBeNull();

    addRule(view, "If a run is already in progress…");

    expect(
      view.getByRole("combobox", { name: "If a run is already in progress" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(
        lifecycleRuleTargetId("overlapping-runs")
      )
    );
    expect(scroller()?.scrollTop ?? 0).toBe(0);
    expect(store.get(historyAtom)).toEqual([]);
    // The rule's controls already show, so the menu stops offering it.
    expect(offeredRules(view)).not.toContain(
      "If a run is already in progress…"
    );
  });

  it("adds a filter from Add a rule by moving focus to the first Filter the arrivals", async () => {
    const { view } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
    });

    addRule(view, "Only start when…");

    await waitFor(() =>
      expect(document.activeElement?.id).toBe(
        lifecycleRuleTargetId("start-filter")
      )
    );
    expect(document.activeElement?.textContent).toBe("Filter the arrivals");
  });

  it("removes a set rule from its label row as one undoable edit", async () => {
    const { view, store, rulesNow } = await renderLifecycle(CONFIGURED);

    fireEvent.click(
      view.getByRole("button", {
        name: "Remove If a run is already in progress",
      })
    );

    expect(rulesNow()?.concurrency).toBe("unlimited");
    expect(
      view.queryByRole("heading", { name: "If a run is already in progress" })
    ).toBeNull();
    expect(store.get(historyAtom)).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(LIFECYCLE_ADD_RULE_ID)
    );
    expect(offeredRules(view)).toContain("If a run is already in progress…");
  });

  it("shows a refusal beneath the rule its check reads", async () => {
    const { aside, region, view } = await renderLifecycle({
      startEvents: ["app/appointment.created"],
      cancelEvents: ["app/appointment.created"],
      concurrency: "unlimited",
      startFilters: { "app/appointment.created": "not a model" },
    });

    // The rules check refuses the Event holding both roles, and the Start
    // Filter check refuses the model it cannot read.
    expect(aside()?.querySelector("header")?.textContent).toContain("2 issues");
    expect(region("Starts when").textContent).toContain(
      "cannot both start and cancel runs"
    );
    expect(view.queryByRole("heading", { name: "Validation" })).toBeNull();
  });

  // ADR-0016: such a filter reads false on every arrival, and Publish refuses
  // it, so the editor shows the same refusal before Publish is tried.
  it("reports a Start Filter reading an undeclared path as blocking, beneath Starts when", async () => {
    const { aside, region } = await renderLifecycle({
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
    const issue = within(region("Starts when")).getByText(/clinicId/, {
      selector: "li",
    });
    expect(issue.className).toContain("text-destructive");
  });

  it("names an Event and an Entity the catalog no longer declares", async () => {
    const { region } = await renderLifecycle({
      startEvents: ["app/retired.event"],
      cancelEvents: [],
      concurrency: "unlimited",
      trackedEntity: {
        type: "retired-entity",
        bindings: { "app/retired.event": "gone" },
      },
    });

    expect(region("Starts when").textContent).toContain("app/retired.event");
    expect(
      within(region("One run per")).getByRole("alert").textContent
    ).toContain("retired-entity is no longer available");
  });

  it("writes an edit through the graph store and autosaves it", async () => {
    const { view, update, rulesNow } = await renderLifecycle(CONFIGURED);

    fireEvent.click(view.getByRole("checkbox", { name: "Can be run by hand" }));

    expect(rulesNow()?.allowManualStart).toBe(true);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("keeps removing a Start Event undoable and prunes its filter", async () => {
    const { view, store, rulesNow } = await renderLifecycle(CONFIGURED);

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    expect(rulesNow()?.startEvents).toEqual([]);
    expect(rulesNow()?.startFilters).toBeUndefined();
    expect(store.get(historyAtom)).toHaveLength(1);
  });

  it("opens at a section from an Event Split with focus on its control, and Back returns there", async () => {
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
      store.set(selectOnlyNodeAtom, "split");
    });

    // What the Event Split's "Open Cancel Events" writes on desktop.
    await act(async () => {
      store.set(openNodeRevealFromOriginAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        nodeId: "lifecycle",
        origin: { nodeId: "split" },
      });
      store.set(revealFieldRequestAtom, {
        nodeId: "lifecycle",
        targetId: lifecycleRuleTargetId("cancel-events"),
      });
    });
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(
        lifecycleRuleTargetId("cancel-events")
      )
    );

    fireEvent.click(view.getByRole("button", { name: "Back" }));

    // Back returns to the Event Split: the active address now inspects the
    // Event Split, at the level its own Browse-only kind clamps to.
    expect(store.get(activeRevealPresentationAtom).inspected).toEqual({
      kind: "node",
      id: "split",
    });
    expect(aside()?.dataset.level).toBe("browse");
  });

  it("offers no Back without an origin, and Escape keeps the Lifecycle Node shown", async () => {
    const { view } = await renderLifecycle(CONFIGURED);
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(
      view.getByRole("complementary", { name: "Start details" })
    ).toBeTruthy();
  });

  // The editor is keyed to the node, and the pickers inside it are what that
  // buys: one entry node replaced by another in the same slot, which is what
  // opening a second workflow does, starts with an empty search. Two of them in
  // one graph is the fixture for that; a real workflow has one.
  it("starts another Lifecycle Node's pickers clean", async () => {
    const second: WorkflowNode = {
      ...lifecycleNode(CONFIGURED),
      id: "lifecycle_2",
    };
    const { view, store } = await renderLifecycle(CONFIGURED, {
      extraNodes: [second],
    });

    const picker = view.getByLabelText("Starts when");
    fireEvent.change(picker, { target: { value: "appoint" } });
    expect((picker as HTMLInputElement).value).toBe("appoint");

    await act(async () => {
      store.set(selectOnlyNodeAtom, "lifecycle_2");
    });

    expect((view.getByLabelText("Starts when") as HTMLInputElement).value).toBe(
      ""
    );
  });

  it("restores the scroll after another workspace and back, writing nothing", async () => {
    const { view, store, scroller } = await renderLifecycle(CONFIGURED);

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
    expect(
      view.getByRole("complementary", { name: "Start details" })
    ).toBeTruthy();
    await waitFor(() => expect(scroller()?.scrollTop).toBe(180));

    expect(store.get(nodesAtom).map((node) => node.position)).toEqual(
      positions
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("keeps Event bindings and eligibility timing under One run per", async () => {
    const { region } = await renderLifecycle(CONFIGURED);

    const entity = region("One run per");
    expect(
      within(entity).getByRole("combobox", { name: "One run per" }).textContent
    ).toContain("Patient");
    expect(within(entity).getByText("When to check")).toBeTruthy();
    expect(
      within(entity).getByRole("checkbox", { name: "Before each step" })
    ).toBeTruthy();
    expect(
      within(entity).queryByRole("button", { name: "Remove this rule" })
    ).toBeNull();
    expect(
      within(entity).getByRole("button", { name: "Remove One run per" })
    ).toBeTruthy();
  });

  it("shows an empty eligibility checkpoint refusal beside the timing controls", async () => {
    const { region } = await renderLifecycle({
      ...CONFIGURED,
      entityEligibility: {
        condition: condition("status", "active"),
        checkpoints: [],
      },
    });

    const entity = region("One run per");
    expect(entity.textContent).toContain("has no checkpoint");
    expect(within(entity).getByText("When to check")).toBeTruthy();
    expect(
      within(entity).getByRole("checkbox", { name: "Before starting a run" })
    ).toBeTruthy();
  });

  it("adds a schedule as one undoable edit", async () => {
    const { view, store, rulesNow, region } = await renderLifecycle({
      ...CONFIGURED,
      trackedEntity: undefined,
      entityEligibility: undefined,
    });
    addRule(view, "On a schedule…");
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(lifecycleRuleTargetId("schedule"))
    );

    fireEvent.click(
      within(region("On a schedule")).getByRole("button", {
        name: "Add schedule",
      })
    );

    expect(rulesNow()?.schedules).toEqual([
      { cron: "0 9 * * *", timeZone: browserTimeZone() },
    ]);
    expect(store.get(historyAtom)).toHaveLength(1);
  });

  it("reads back each schedule with its next run", async () => {
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

      const schedule = region("On a schedule").textContent;
      expect(schedule).toContain("Every weekday at 9:00 AM (America/New_York)");
      expect(schedule).toContain("Next: Fri Nov 6, 9:00 AM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an unsaved schedule's refusal beneath the schedules", async () => {
    const { rulesNow, region } = await renderLifecycle({
      ...CONFIGURED,
      trackedEntity: undefined,
      entityEligibility: undefined,
      schedules: [{ cron: "0 9 * * *", timeZone: browserTimeZone() }],
    });

    const section = region("On a schedule");
    fireEvent.click(
      within(section).getByRole("button", { name: "Add schedule" })
    );

    expect(section.textContent).toContain(
      "Two schedules have the same cron expression and time zone."
    );
    expect(rulesNow()?.schedules).toHaveLength(1);
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
