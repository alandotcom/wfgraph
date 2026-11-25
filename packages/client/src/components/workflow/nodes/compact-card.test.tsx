import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { ActionNode } from "#src/components/workflow/nodes/action-node";
import { GroupNode } from "#src/components/workflow/nodes/group-node";
import { LifecycleNode } from "#src/components/workflow/nodes/lifecycle-node";
import { WORKFLOW_COMPACT_CARD_ZOOM } from "#src/components/workflow/workflow-viewport";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { NODE_COMPACT_TYPE_PX } from "#src/lib/workflow-node-dimensions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

// Required NodeProps fields the cards never read.
const requiredNodeProps = {
  dragging: false,
  zIndex: 0,
  selectable: true,
  deletable: true,
  draggable: true,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  selected: false,
} as const;

const reminder: WorkflowNodeData = {
  label: "Send 24-hour reminder",
  description: "Texts the patient a day before",
  type: "action",
  config: { actionType: "Send SMS" },
  status: "idle",
};

/**
 * Renders `card` inside a React Flow store at `zoom`, with `numbers` as the
 * outline's step numbers. `setZoom` moves the canvas zoom as a pinch would.
 */
function renderAtZoom(input: {
  card: ReactNode;
  zoom: number;
  numbers?: ReadonlyMap<string, number>;
}) {
  const store = createStore();
  store.set(stepNumbersAtom, input.numbers ?? new Map());
  let flow: ReturnType<typeof useStoreApi> | null = null;
  function CaptureFlow() {
    flow = useStoreApi();
    return null;
  }
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <ReactFlowProvider>
              <CaptureFlow />
              {input.card}
            </ReactFlowProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </Provider>
    </QueryClientProvider>
  );
  const setZoom = (zoom: number) => {
    act(() => {
      flow?.setState({ transform: [0, 0, zoom] });
    });
  };
  setZoom(input.zoom);
  return { view, setZoom };
}

const compactBody = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-slot='node-compact-body']");
const stepNumber = (container: HTMLElement) =>
  container.querySelector("[data-slot='node-step-number']")?.textContent;

describe("a step card's compact form", () => {
  it("draws the full card with its step number at or above the compact zoom", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: WORKFLOW_COMPACT_CARD_ZOOM,
      numbers: new Map([["remind", 4]]),
    });

    expect(compactBody(view.container)).toBeNull();
    expect(stepNumber(view.container)).toBe("4");
    expect(view.getByText("Texts the patient a day before")).toBeTruthy();
  });

  it("draws only the step number and the title below the compact zoom", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: WORKFLOW_COMPACT_CARD_ZOOM - 0.01,
      numbers: new Map([["remind", 4]]),
    });

    const body = compactBody(view.container);
    expect(body?.textContent).toBe("4Send 24-hour reminder");
    expect(body?.style.fontSize).toBe(`${NODE_COMPACT_TYPE_PX}px`);
    expect(view.queryByText("Texts the patient a day before")).toBeNull();
    expect(
      view.getByTestId("action-node-remind").getAttribute("data-card-form")
    ).toBe("compact");
  });

  it("keeps the card's handles while compact, so connections stay attached", () => {
    const { view, setZoom } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 1,
    });
    const handles = () =>
      [...view.container.querySelectorAll(".react-flow__handle")].map(
        (handle) => handle.getAttribute("aria-label")
      );
    const full = handles();

    setZoom(0.4);

    expect(compactBody(view.container)).not.toBeNull();
    expect(handles()).toEqual(full);
  });

  it("draws no number for a step the outline has not numbered", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.5,
    });

    expect(stepNumber(view.container)).toBeUndefined();
    expect(compactBody(view.container)?.textContent).toBe(
      "Send 24-hour reminder"
    );
  });

  it("keeps the run status, the issue mark and the change marker while compact", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={{
            ...reminder,
            status: "error",
            issues: { severity: "blocking", messages: ["Choose a Connection"] },
            [COMPARISON_NODE_ANNOTATION]: { kind: "modified" },
          }}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.5,
    });

    const card = view.getByTestId("action-node-remind");
    expect(compactBody(view.container)).not.toBeNull();
    expect(card.className).toContain("border-destructive");
    expect(view.getByRole("status").textContent).toBe("Failed");
    expect(view.getByRole("img", { name: "1 blocking issue" })).toBeTruthy();
    expect(card.querySelector(".comparison-marker")?.textContent).toBe("M");
  });

  it("switches back to the full card once the zoom rises past the compact zoom", () => {
    const { view, setZoom } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.5,
      numbers: new Map([["remind", 4]]),
    });
    expect(compactBody(view.container)).not.toBeNull();

    setZoom(0.9);

    expect(compactBody(view.container)).toBeNull();
    expect(view.getByText("Texts the patient a day before")).toBeTruthy();
    expect(stepNumber(view.container)).toBe("4");
  });
});

describe("the Lifecycle card's compact form", () => {
  it("draws its title beside the Play glyph and keeps its outlet captions", () => {
    const { view } = renderAtZoom({
      card: (
        <LifecycleNode
          data={{
            label: "Appointment booked",
            description: "Starts when an appointment is booked",
            type: "lifecycle",
            config: {},
          }}
          id="entry"
          type="lifecycle"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.5,
    });

    const body = compactBody(view.container);
    expect(body?.textContent).toBe("Appointment booked");
    expect(body?.querySelector("svg")).not.toBeNull();
    expect(view.queryByText("Starts when an appointment is booked")).toBeNull();
    expect(view.getByText("Started")).toBeTruthy();
    expect(view.getByText("Canceled")).toBeTruthy();
  });
});

describe("a Group card's compact form", () => {
  async function renderGroup(input: {
    zoom: number;
    numbers?: ReadonlyMap<string, number>;
  }) {
    const card = (
      <GroupNode
        data={{
          label: "Reminder sequence",
          description: "Two reminders before the visit",
          type: "group",
          config: {},
        }}
        id="reminders"
        type="group"
        {...requiredNodeProps}
      />
    );
    const rootRoute = createRootRoute();
    const workflowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workflows/$workflowId",
      component: () => card,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([workflowRoute]),
      history: createMemoryHistory({ initialEntries: ["/workflows/wf_1"] }),
    });
    // The router resolves its first match in a microtask, which mounts the
    // card.
    const result = renderAtZoom({
      card: <RouterProvider router={router} />,
      zoom: input.zoom,
      ...(input.numbers ? { numbers: input.numbers } : {}),
    });
    await act(async () => {
      await router.load();
    });
    return result;
  }

  it("draws its label beside the Group glyph, and its number when it has one", async () => {
    const unnumbered = await renderGroup({ zoom: 0.5 });
    const body = compactBody(unnumbered.view.container);
    expect(body?.textContent).toBe("Reminder sequence");
    expect(body?.querySelector("svg")).not.toBeNull();
    expect(
      unnumbered.view.queryByText("Two reminders before the visit")
    ).toBeNull();
    unnumbered.view.unmount();

    const numbered = await renderGroup({
      zoom: 0.5,
      numbers: new Map([["reminders", 5]]),
    });
    expect(compactBody(numbered.view.container)?.textContent).toBe(
      "5Reminder sequence"
    );
  });

  it("draws the full card, with its number in the title band, at detail zoom", async () => {
    const { view } = await renderGroup({
      zoom: 1,
      numbers: new Map([["reminders", 5]]),
    });

    expect(compactBody(view.container)).toBeNull();
    expect(stepNumber(view.container)).toBe("5");
    expect(view.getByText("Two reminders before the visit")).toBeTruthy();
  });
});
