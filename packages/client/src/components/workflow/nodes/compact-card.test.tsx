import { act, fireEvent, render } from "@testing-library/react";
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
import {
  WORKFLOW_COMPACT_CARD_ZOOM,
  WORKFLOW_NUMBER_CARD_ZOOM,
} from "#src/components/workflow/workflow-viewport";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import { collapsedGroupIdsAtom } from "#src/lib/collapsed-groups";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";

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
  collapsedGroupIds?: ReadonlySet<string>;
}) {
  const store = createStore();
  store.set(stepNumbersAtom, input.numbers ?? new Map());
  store.set(collapsedGroupIdsAtom, input.collapsedGroupIds ?? new Set());
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
    // The number sits in the top row, and the title below it has the card's
    // full width and breaks only between words.
    const title = body?.querySelector<HTMLElement>(
      "[data-slot='node-compact-title']"
    );
    expect(title?.textContent).toBe("Send 24-hour reminder");
    expect(title?.style.hyphens).toBe("manual");
    expect(title?.className).toContain("[overflow-wrap:normal]");
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

    setZoom(0.6);

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
      zoom: 0.6,
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
      zoom: 0.6,
    });

    const card = view.getByTestId("action-node-remind");
    const body = compactBody(view.container);
    expect(card.className).toContain("border-destructive");
    // The status is a mark at the compact type size, named by its word.
    const status = view.getByRole("status", { name: "Failed" });
    expect(status.getAttribute("data-slot")).toBe("node-status-mark");
    expect(status.querySelector("svg")?.style.width).toBe("22px");
    // The issue badge sits in the top row beside the number.
    expect(
      body?.querySelector("[role='img'][aria-label='1 blocking issue']")
    ).not.toBeNull();
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
      zoom: 0.6,
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
  it("draws its title below the Play glyph and drops its outlet captions", () => {
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
      zoom: 0.6,
    });

    const body = compactBody(view.container);
    expect(body?.textContent).toBe("Appointment booked");
    expect(body?.querySelector("svg")).not.toBeNull();
    expect(view.queryByText("Starts when an appointment is booked")).toBeNull();
    // The outline names both outlets; the handles stay.
    expect(view.queryByText("Started")).toBeNull();
    expect(view.queryByText("Canceled")).toBeNull();
    expect(view.getByLabelText("Started outlet")).toBeTruthy();
  });
});

describe("a Group on the canvas", () => {
  function renderGroup(input: {
    zoom: number;
    numbers?: ReadonlyMap<string, number>;
    collapsed?: boolean;
  }) {
    return renderAtZoom({
      card: (
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
      ),
      zoom: input.zoom,
      ...(input.numbers ? { numbers: input.numbers } : {}),
      collapsedGroupIds: new Set(input.collapsed ? ["reminders"] : []),
    });
  }

  const header = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-slot='group-region-header']");

  it("draws in place as a region whose header names it, with its number", () => {
    const { view } = renderGroup({
      zoom: 1,
      numbers: new Map([["reminders", 5]]),
    });

    expect(
      view.getByTestId("group-node-reminders").getAttribute("data-group-form")
    ).toBe("region");
    expect(header(view.container)?.textContent).toContain("Reminder sequence");
    expect(stepNumber(view.container)).toBe("5");
    // The region has no handles of its own: connections attach to members.
    expect(view.container.querySelector(".react-flow__handle")).toBeNull();
  });

  it("sets the region's header in the compact type size when zoomed out", () => {
    const { view } = renderGroup({ zoom: 0.6 });

    expect(header(view.container)?.style.fontSize).toBe("21px");
    expect(compactBody(view.container)).toBeNull();
  });

  it("draws one card the viewer collapsed it to, with its glyph or number", () => {
    const unnumbered = renderGroup({ zoom: 0.6, collapsed: true });
    const body = compactBody(unnumbered.view.container);
    expect(body?.textContent).toBe("Reminder sequence");
    expect(body?.querySelector("svg")).not.toBeNull();
    expect(
      unnumbered.view.queryByText("Two reminders before the visit")
    ).toBeNull();
    unnumbered.view.unmount();

    const numbered = renderGroup({
      zoom: 1,
      numbers: new Map([["reminders", 5]]),
      collapsed: true,
    });
    expect(compactBody(numbered.view.container)).toBeNull();
    expect(stepNumber(numbered.view.container)).toBe("5");
    expect(
      numbered.view.getByText("Two reminders before the visit")
    ).toBeTruthy();
    expect(
      numbered.view.getByRole("button", {
        name: "Expand group Reminder sequence",
      })
    ).toBeTruthy();
  });

  it("collapses from the region's header and expands from the card", () => {
    const { view } = renderGroup({ zoom: 1 });

    fireEvent.click(
      view.getByRole("button", { name: "Collapse group Reminder sequence" })
    );
    expect(
      view.getByTestId("group-node-reminders").getAttribute("data-group-form")
    ).toBe("card");

    fireEvent.click(
      view.getByRole("button", { name: "Expand group Reminder sequence" })
    );
    expect(
      view.getByTestId("group-node-reminders").getAttribute("data-group-form")
    ).toBe("region");
  });
});

describe("captions while cards are compact", () => {
  it("drops a Condition's outlet captions and keeps its handles", () => {
    const condition: WorkflowNodeData = {
      label: "Deposit covers the visit?",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
      status: "idle",
    };
    const { view, setZoom } = renderAtZoom({
      card: (
        <ActionNode
          data={condition}
          id="deposit"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 1,
    });
    expect(view.getByText("True")).toBeTruthy();

    setZoom(0.6);

    expect(view.queryByText("True")).toBeNull();
    expect(view.queryByText("False")).toBeNull();
    expect(view.getByLabelText("True outlet")).toBeTruthy();
  });
});

describe("a compact title the page breaks onto more lines than measured", () => {
  it("steps down to a size that shows the whole title before the card paints", () => {
    // happy-dom lays nothing out, so the title reports overflow itself while
    // it draws above 23px, as a browser did for "Enough time / for…".
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.slot === "node-compact-title" &&
          Number.parseFloat(this.style.fontSize) > 23
          ? 100
          : 0;
      },
    });
    try {
      const { view } = renderAtZoom({
        card: (
          <ActionNode
            data={{ ...reminder, label: "Enough time for reminders?" }}
            id="enough"
            type="action"
            {...requiredNodeProps}
          />
        ),
        zoom: 0.6,
      });
      const title = view.container.querySelector<HTMLElement>(
        "[data-slot='node-compact-title']"
      );
      expect(title?.style.fontSize).toBe("23px");
      expect(title?.className).toContain("line-clamp-3");
    } finally {
      if (scrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeight
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });
});

describe("the number tier, below a compact title's 11px", () => {
  const numberBody = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-slot='node-number-body']");

  it("draws a step's number and its kind's glyph, and no title", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={reminder}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: WORKFLOW_NUMBER_CARD_ZOOM - 0.01,
      numbers: new Map([["remind", 4]]),
    });

    const body = numberBody(view.container);
    expect(body?.textContent).toBe("4");
    expect(body?.querySelector("svg")).not.toBeNull();
    expect(view.queryByText("Send 24-hour reminder")).toBeNull();
    expect(compactBody(view.container)).toBeNull();
    expect(
      view.getByTestId("action-node-remind").getAttribute("data-card-form")
    ).toBe("number");
  });

  it("keeps the run status, the issue mark and the change marker", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={{
            ...reminder,
            status: "waiting",
            issues: { severity: "blocking", messages: ["Choose a Connection"] },
            [COMPARISON_NODE_ANNOTATION]: { kind: "added" },
          }}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.3,
      numbers: new Map([["remind", 4]]),
    });

    expect(view.getByRole("status", { name: "Waiting" })).toBeTruthy();
    expect(
      view
        .getByRole("img", { name: "1 blocking issue" })
        .closest("[data-slot='node-number-marks']")
    ).not.toBeNull();
    expect(
      view.getByTestId("action-node-remind").querySelector(".comparison-marker")
        ?.textContent
    ).toBe("A");
  });

  it("draws the Lifecycle card's glyph alone", () => {
    const { view } = renderAtZoom({
      card: (
        <LifecycleNode
          data={{ label: "Appointment booked", type: "lifecycle", config: {} }}
          id="entry"
          type="lifecycle"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.3,
    });

    const body = numberBody(view.container);
    expect(body?.textContent).toBe("");
    expect(body?.querySelector("svg")).not.toBeNull();
  });

  it("gives a Group region's header its glyph and step count, and no collapse control", () => {
    const { view } = renderAtZoom({
      card: (
        <GroupNode
          data={{ label: "Reminder sequence", type: "group", config: {} }}
          id="reminders"
          type="group"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.3,
    });

    const mark = view.container.querySelector<HTMLElement>(
      "[data-slot='group-region-header-mark']"
    );
    expect(mark?.querySelector("svg")).not.toBeNull();
    expect(view.getByText("0 steps")).toBeTruthy();
    expect(view.queryByRole("button", { name: /Collapse group/ })).toBeNull();
  });

  it("keeps the region header's name and drops its collapse control while compact", () => {
    const { view } = renderAtZoom({
      card: (
        <GroupNode
          data={{ label: "Pre-visit reminders", type: "group", config: {} }}
          id="reminders"
          type="group"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.6,
    });

    expect(view.getByText("Pre-visit reminders").className).toContain(
      "line-clamp-2"
    );
    expect(view.queryByRole("button", { name: /Collapse group/ })).toBeNull();
  });
});
