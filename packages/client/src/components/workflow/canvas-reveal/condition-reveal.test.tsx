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
import { ReactFlowProvider } from "@xyflow/react";
import { Schema } from "effect";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useShowWorkflowIssues } from "#src/hooks/use-workflow-issues";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  getUpstreamConditionFields,
  type ConditionSelectableField,
} from "#src/lib/upstream-node-fields";
import {
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  startedEdge,
} from "#src/lib/upstream-node-fields-test-support";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  createDefaultConditionRule,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { CanvasReveal } from "./canvas-reveal";

const EVENT = "app/patient.updated";

const catalog: ExtensionCatalog = {
  entities: [],
  integrations: [],
  actions: [],
  events: [
    anEvent({
      name: EVENT,
      label: "Patient updated",
      schema: Schema.Struct({
        data: Schema.Struct({
          status: Schema.String,
          plan: Schema.String,
          region: Schema.String,
          language: Schema.String,
          clinic: Schema.String,
          reminders: Schema.Boolean,
        }),
      }),
    }),
  ],
};

const conditionNode = (config: Record<string, unknown> = {}): WorkflowNode =>
  createNode({
    id: "condition",
    type: "action",
    label: "Patient eligible?",
    config: { actionType: BUILT_IN_ACTION_IDS.condition, ...config },
  });

const BASE_NODES: WorkflowNode[] = [
  anEntryNode({ startEvents: [EVENT] }),
  createNode({
    id: "send",
    type: "action",
    label: "Send reminder",
    config: { actionType: BUILT_IN_ACTION_IDS.wait },
  }),
  createNode({
    id: "skip",
    type: "action",
    label: "Skip reminder",
    config: { actionType: BUILT_IN_ACTION_IDS.wait },
  }),
];

const TRUE_EDGE = createEdge({
  id: "e-true",
  source: "condition",
  sourceHandle: "true",
  target: "send",
});
const FALSE_EDGE = createEdge({
  id: "e-false",
  source: "condition",
  sourceHandle: "false",
  target: "skip",
});

/** The values a Condition below the Lifecycle node can compare. */
function upstreamFields(): ConditionSelectableField[] {
  return getUpstreamConditionFields({
    currentNodeId: "condition",
    nodes: [...BASE_NODES, conditionNode()],
    edges: [startedEdge("condition")],
    catalog,
  });
}

function fieldEndingWith(suffix: string): ConditionSelectableField {
  const field = upstreamFields().find((item) => item.path.endsWith(suffix));
  if (!field) {
    throw new Error(`no upstream field ends with ${suffix}`);
  }
  return field;
}

function rule(suffix: string, id: string, value?: string): ConditionRule {
  const seeded = createDefaultConditionRule(fieldEndingWith(suffix), id);
  return seeded.fieldType === "string" && "value" in seeded
    ? { ...seeded, value: value ?? "active" }
    : seeded;
}

/** The config keys a Condition stores for `model`: the model and its CEL. */
function storedRules(model: ConditionModel): Record<string, unknown> {
  const compiled = compileConditionModel(model);
  return {
    conditionModel: serializeConditionModel(model),
    condition: compiled.valid ? compiled.expression : "",
  };
}

/** A Group frame the Condition can sit inside, beside a second member. */
const GROUP_NODE: WorkflowNode = {
  id: "group_1",
  type: "group",
  position: { x: 0, y: 0 },
  width: 400,
  height: 300,
  data: { label: "Eligibility", type: "group" },
};

/**
 * Opens the workflow issues overlay through the same hook the toolbar's issues
 * chip uses, so a test can drive an issue's own "Fix" button rather than call
 * `onGoToStep` directly.
 */
function ShowIssuesButton() {
  const showIssues = useShowWorkflowIssues();
  return (
    <button onClick={showIssues} type="button">
      Show issues
    </button>
  );
}

async function renderCondition(input: {
  config?: Record<string, unknown>;
  edges?: WorkflowEdge[];
  upstream?: boolean;
  /** Places the Condition inside a Group frame. */
  grouped?: boolean;
}) {
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  const condition = conditionNode(input.config);
  store.set(loadWorkflowGraphAtom, {
    nodes: input.grouped
      ? [
          GROUP_NODE,
          ...BASE_NODES,
          {
            ...createNode({
              id: "lookup",
              type: "action",
              label: "Look up patient",
              config: { actionType: BUILT_IN_ACTION_IDS.wait },
            }),
            parentId: GROUP_NODE.id,
            extent: "parent",
          },
          { ...condition, parentId: GROUP_NODE.id, extent: "parent" },
        ]
      : [...BASE_NODES, condition],
    edges: [
      ...(input.upstream === false ? [] : [startedEdge("condition")]),
      ...(input.edges ?? []),
    ],
  });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(store, {});

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <div data-testid="workflow-canvas" tabIndex={-1} />
        <CanvasReveal />
        <ShowIssuesButton />
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
              <OverlayContainer />
            </OverlayProvider>
          </ReactFlowProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");
  await act(async () => {
    store.set(selectOnlyNodeAtom, "condition");
  });
  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const region = () =>
    view.getByRole("complementary", { name: "Condition inspector" });
  const section = (title: string) => {
    const heading = view
      .getAllByRole("heading", { name: title })
      .find((element) => element.tagName === "H3");
    const element = heading?.closest("section");
    if (!element) {
      throw new Error(`no section titled ${title}`);
    }
    return element;
  };
  return {
    view,
    store,
    update,
    aside,
    region,
    section,
    level: () => aside()?.dataset.level,
  };
}

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

describe("Condition Browse", () => {
  it("opens a Condition inspector with Browse and Focus", async () => {
    const { view, level, region } = await renderCondition({});

    expect(level()).toBe("browse");
    expect(region().textContent).toContain("Draft");
    expect(
      view.getByRole("heading", { name: "Patient eligible?" })
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Focus editor" })).toBeTruthy();
    expect(view.queryByTestId("properties-panel")).toBeNull();
  });

  it("says an empty Condition has no rules, no values, and no branches", async () => {
    const { section } = await renderCondition({ upstream: false });

    expect(section("Continue when").textContent).toContain("No rules yet.");
    expect(section("Available values").textContent).toContain(
      "No values reach this Condition."
    );
    const branches = section("Branches").textContent;
    expect(branches).toContain("A run that takes True ends here.");
    expect(branches).toContain("A run that takes False ends here.");
  });

  it("reads a single rule as a sentence and names both destinations", async () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [{ id: "g1", logic: "and", conditions: [rule("status", "r1")] }],
    };
    const { section } = await renderCondition({
      config: storedRules(model),
      edges: [TRUE_EDGE, FALSE_EDGE],
    });

    const rules = section("Continue when").textContent;
    expect(rules).toContain("True when the rule matches, and False otherwise.");
    expect(rules).toContain("status");
    expect(rules).toContain("active");
    const branches = section("Branches").textContent;
    expect(branches).toContain("Continues to Send reminder");
    expect(branches).toContain("Continues to Skip reminder");
    expect(section("Available values").textContent).toContain(
      "6 values from earlier steps can be compared."
    );
  });

  it("opens Focus on every available input past the first five", async () => {
    const { view, level } = await renderCondition({});

    fireEvent.click(view.getByRole("button", { name: "Show all 6 values" }));
    expect(level()).toBe("focus");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Available inputs")
    );
  });

  it("reads grouped rules with their AND and OR logic", async () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "or",
      groups: [
        {
          id: "g1",
          logic: "and",
          conditions: [rule("status", "r1"), rule("plan", "r2", "gold")],
        },
        { id: "g2", logic: "and", conditions: [rule("reminders", "r3")] },
      ],
    };
    const { section } = await renderCondition({
      config: storedRules(model),
      edges: [TRUE_EDGE],
    });

    const rules = section("Continue when");
    expect(rules.textContent).toContain(
      "True when any of the 2 groups matches, and False otherwise."
    );
    expect(rules.textContent).toContain("AND");
    expect(rules.textContent).toContain("OR");
    expect(section("Branches").textContent).toContain(
      "A run that takes False ends here."
    );
  });

  it("marks unreadable rules and opens the rule builder from the issue", async () => {
    const { view, store, section, level } = await renderCondition({
      config: { conditionModel: "{not json", condition: "" },
    });
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "condition",
          nodeLabel: "Patient eligible?",
          fieldKey: "condition",
          fieldLabel: "Condition",
          message: "Condition is required.",
        },
      ]);
    });

    expect(section("Continue when").textContent).toContain(
      "The rules can't be read."
    );
    expect(view.getByText("1 issue")).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "Condition is required." })
    );
    expect(level()).toBe("focus");
    await waitFor(() => expect(document.activeElement?.id).toBe("condition"));
    expect(view.getByText("Condition model must be valid JSON")).toBeTruthy();
  });

  it("opens the rule builder from an issue naming the stored model", async () => {
    const { view, store, level } = await renderCondition({});
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "broken_reference",
          severity: "warning",
          nodeId: "condition",
          nodeLabel: "Patient eligible?",
          fieldKey: "conditionModel",
          fieldLabel: "Condition",
          referencedNodeId: "removed",
          displayText: "Removed step",
          message: "Condition references a missing step.",
        },
      ]);
    });

    fireEvent.click(
      view.getByRole("button", { name: "Condition references a missing step." })
    );
    expect(level()).toBe("focus");
    await waitFor(() => expect(document.activeElement?.id).toBe("condition"));
  });

  // The workflow issues overlay's own "Fix" button reaches the rule builder
  // through the same `revealFocusTarget` mapping Reveal's own issue list uses
  // above, rather than opening Browse with the raw `conditionModel` key.
  it("opens Focus on the rule builder from a conditionModel issue in the workflow issues overlay", async () => {
    const { view, store, level } = await renderCondition({});
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "broken_reference",
          severity: "warning",
          nodeId: "condition",
          nodeLabel: "Patient eligible?",
          fieldKey: "conditionModel",
          fieldLabel: "Condition",
          referencedNodeId: "removed",
          displayText: "Removed step",
          message: "Condition references a missing step.",
        },
      ]);
    });

    fireEvent.click(view.getByRole("button", { name: "Show issues" }));
    fireEvent.click(view.getByRole("button", { name: "Fix" }));

    expect(level()).toBe("focus");
    await waitFor(() => expect(document.activeElement?.id).toBe("condition"));
  });

  it("ungroups a grouped Condition", async () => {
    const { view, store } = await renderCondition({ grouped: true });

    fireEvent.click(view.getByRole("button", { name: "Ungroup" }));

    const nodes = store.get(nodesAtom);
    expect(nodes.find((node) => node.id === "group_1")).toBeUndefined();
    expect(
      nodes.find((node) => node.id === "condition")?.parentId
    ).toBeUndefined();
  });
});

describe("Condition Focus", () => {
  const singleRule: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [{ id: "g1", logic: "and", conditions: [rule("status", "r1")] }],
  };

  it("ungroups a grouped Condition", async () => {
    const { view, store, level } = await renderCondition({
      config: storedRules(singleRule),
      grouped: true,
    });
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(level()).toBe("focus");

    fireEvent.click(view.getByRole("button", { name: "Ungroup" }));

    const nodes = store.get(nodesAtom);
    expect(nodes.find((node) => node.id === "group_1")).toBeUndefined();
    expect(
      nodes.find((node) => node.id === "condition")?.parentId
    ).toBeUndefined();
  });

  it("holds the rule builder, inputs, branches, issues, and delete", async () => {
    const { view, section } = await renderCondition({
      config: storedRules(singleRule),
      edges: [TRUE_EDGE],
    });
    fireEvent.click(view.getByRole("button", { name: "Edit rules" }));

    expect(view.getByRole("button", { name: "Add group" })).toBeTruthy();
    expect(
      view.getByRole("button", { name: /Remove condition on/ })
    ).toBeTruthy();
    const inputs = section("Available inputs");
    for (const path of ["status", "plan", "region", "clinic", "reminders"]) {
      expect(inputs.textContent).toContain(path);
    }
    expect(section("Branches").textContent).toContain(
      "Continues to Send reminder"
    );
    expect(section("Validation").textContent).toContain("No issues.");
    expect(view.getByRole("button", { name: /Delete/ })).toBeTruthy();
  });

  it("keeps rule edits, selection, and scroll between Browse and Focus in one autosave", async () => {
    const { view, store, update, aside, level, section } =
      await renderCondition({
        config: storedRules(singleRule),
        edges: [TRUE_EDGE, FALSE_EDGE],
      });
    const history = store.get(historyAtom);

    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(level()).toBe("focus");
    expect(store.get(historyAtom)).toBe(history);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Add condition" }));
    fireEvent.change(view.getByLabelText("Description"), {
      target: { value: "Only active patients" },
    });
    const scroller = () =>
      aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const body = scroller();
    if (!body) {
      throw new Error("the Focus body did not render");
    }
    body.scrollTop = 180;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));

    fireEvent.click(view.getByRole("button", { name: "Return to summary" }));
    expect(level()).toBe("browse");
    expect(section("Continue when").textContent).toContain(
      "True when each of the 2 rules matches, and False otherwise."
    );
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["condition"]);

    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(level()).toBe("focus");
    expect((view.getByLabelText("Description") as HTMLInputElement).value).toBe(
      "Only active patients"
    );
    expect(
      view.getAllByRole("button", { name: /Remove condition on/ })
    ).toHaveLength(2);
    await waitFor(() => expect(scroller()?.scrollTop).toBe(180));

    const saved = store.get(nodesAtom).find((item) => item.id === "condition");
    expect(saved?.data.description).toBe("Only active patients");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const payload = JSON.stringify(update.mock.calls[0]);
    expect(payload).toContain("conditionModel");
    expect(payload).toContain("Only active patients");
  });
});
