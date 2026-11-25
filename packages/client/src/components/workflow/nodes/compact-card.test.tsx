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

/** A card's content while it draws its compact form, or null. */
const compactBody = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>("[data-slot='node-compact-title']")
    ?.closest<HTMLElement>("[data-slot='node-content']") ?? null;
/** A card's lead row: its glyph, step number and marks. */
const leadRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-slot='node-lead']");
const stepNumber = (container: HTMLElement) =>
  container.querySelector("[data-slot='node-step-number']")?.textContent;

describe("a card's one anatomy", () => {
  it("keeps the glyph and the number in the lead row at every tier, and drops the description, then the title", () => {
    const { view, setZoom } = renderAtZoom({
      card: (
        <ActionNode
          data={{ ...reminder, status: "error" }}
          id="remind"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 1,
      numbers: new Map([["remind", 4]]),
    });
    const shown = () => {
      const lead = leadRow(view.container);
      return {
        form: view
          .getByTestId("action-node-remind")
          .getAttribute("data-card-form"),
        // The lead row opens the card's content at every tier.
        leadFirst:
          lead !== null &&
          lead.parentElement?.firstElementChild === lead &&
          lead.parentElement.dataset.slot === "node-content",
        glyph: lead?.querySelector("svg") !== null,
        number: lead?.querySelector("[data-slot='node-step-number']")
          ?.textContent,
        title: view.queryAllByText("Send 24-hour reminder").length > 0,
        description:
          view.queryByText("Texts the patient a day before") !== null,
        status: view.queryAllByRole("status").length,
      };
    };

    expect(shown()).toEqual({
      form: "full",
      leadFirst: true,
      glyph: true,
      number: "4",
      title: true,
      description: true,
      status: 1,
    });
    setZoom(0.6);
    expect(shown()).toEqual({
      form: "compact",
      leadFirst: true,
      glyph: true,
      number: "4",
      title: true,
      description: false,
      status: 1,
    });
    setZoom(0.3);
    expect(shown()).toEqual({
      form: "number",
      leadFirst: true,
      glyph: true,
      number: "4",
      title: false,
      description: false,
      status: 1,
    });
  });

  it("sets the title in one weight at every tier", () => {
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
    const titleClass = () =>
      view
        .getAllByText("Send 24-hour reminder")
        .map((element) => element.className)
        .join(" ");

    expect(titleClass()).toContain("font-medium");
    setZoom(0.6);
    expect(titleClass()).toContain("font-medium");
    expect(titleClass()).not.toContain("font-semibold");
  });
});

describe("a card's kind glyph", () => {
  it("draws a host action's glyph in graphite and keeps amber for a Wait", () => {
    const host = renderAtZoom({
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
    const hostGlyph = leadRow(host.view.container)?.querySelector("svg");
    expect(hostGlyph?.getAttribute("class")).toContain("text-muted-foreground");
    expect(hostGlyph?.getAttribute("class")).not.toContain("text-node-wait");
    host.view.unmount();

    const wait = renderAtZoom({
      card: (
        <ActionNode
          data={{
            ...reminder,
            config: { actionType: BUILT_IN_ACTION_IDS.wait },
          }}
          id="wait"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 1,
    });
    expect(
      leadRow(wait.view.container)?.querySelector("svg")?.getAttribute("class")
    ).toContain("text-node-wait");
  });
});

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
    // The glyph and number sit in the lead row, and the title below it has
    // the card's full width and breaks only between words.
    expect(leadRow(view.container)?.querySelector("svg")).not.toBeNull();
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

  it("holds its border, and a heavier run status border, at a width on screen at every zoom", () => {
    for (const zoom of [0.34, 0.6, 1]) {
      const resting = renderAtZoom({
        card: (
          <ActionNode
            data={reminder}
            id="resting"
            type="action"
            {...requiredNodeProps}
          />
        ),
        zoom,
      });
      const failed = renderAtZoom({
        card: (
          <ActionNode
            data={{ ...reminder, status: "error" }}
            id="failed"
            type="action"
            {...requiredNodeProps}
          />
        ),
        zoom,
      });

      // Both widths come from `--canvas-stroke` and `--canvas-stroke-heavy`,
      // which divide by the live zoom, so neither thins as the canvas zooms
      // out.
      const restingCard = resting.view.getByTestId("action-node-resting");
      const failedCard = failed.view.getByTestId("action-node-failed");
      expect(restingCard.className).toContain(
        "border-(length:--canvas-stroke)"
      );
      expect(failedCard.className).toContain(
        "border-(length:--canvas-stroke-heavy)"
      );
      expect(failedCard.className).not.toMatch(/border-2|border-\[/);
      resting.view.unmount();
      failed.view.unmount();
    }
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

  it("draws its region on the Canvas Region fill, with a dashed border held on screen", () => {
    const { view } = renderGroup({ zoom: 0.34 });
    const region = view.container.querySelector<HTMLElement>(
      ".group-node-container"
    );
    expect(region?.className).toContain("bg-canvas-region");
    expect(region?.className).toContain("border-(length:--canvas-stroke)");
    expect(region?.className).toContain("border-dashed");
  });

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
    // it draws above 22px, as a browser does for a title it breaks onto one
    // more line than the measure predicted.
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.slot === "node-compact-title" &&
          Number.parseFloat(this.style.fontSize) > 22
          ? 100
          : 0;
      },
    });
    try {
      const { view } = renderAtZoom({
        card: (
          <ActionNode
            data={{ ...reminder, label: "Send intake form" }}
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
      expect(title?.style.fontSize).toBe("22px");
      expect(title?.className).toContain("line-clamp-2");
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
  /** A card's content while it draws its number tier, or null. */
  const numberBody = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      "[data-card-form='number'] [data-slot='node-content']"
    );

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
        .closest("[data-slot='node-lead']")
    ).not.toBeNull();
    expect(
      view.getByTestId("action-node-remind").querySelector(".comparison-marker")
        ?.textContent
    ).toBe("A");
  });

  it("hands the stylesheet the card's size and the lead row's, so the row fits the card", () => {
    const leadAt = (value: number) => {
      const { view } = renderAtZoom({
        card: (
          <ActionNode
            data={reminder}
            id="remind"
            type="action"
            {...requiredNodeProps}
          />
        ),
        zoom: 0.25,
        numbers: new Map([["remind", value]]),
      });
      const style = leadRow(view.container)?.style;
      const sizes = {
        card: [
          style?.getPropertyValue("--card-width"),
          style?.getPropertyValue("--card-height"),
        ],
        lead: Number(style?.getPropertyValue("--lead-width")),
        height: Number(style?.getPropertyValue("--lead-height")),
      };
      view.unmount();
      return sizes;
    };

    // Where nothing lays the row out, its size is estimated from a 25.3px
    // glyph, a 6px gap and a 13.6px tabular digit, each at 22px type.
    const one = leadAt(4);
    const two = leadAt(12);
    const three = leadAt(104);
    expect(one.card).toEqual(["192", "112"]);
    expect(one.height).toBeCloseTo(25.3);
    expect(one.lead).toBeCloseTo(25.3 + 6 + 13.64);
    expect(two.lead - one.lead).toBeCloseTo(13.64);
    expect(three.lead - two.lead).toBeCloseTo(13.64);
  });

  it("marks a waiting step with a clock, apart from the Wait step's hourglass", () => {
    const { view } = renderAtZoom({
      card: (
        <ActionNode
          data={{
            ...reminder,
            status: "waiting",
            config: { actionType: BUILT_IN_ACTION_IDS.wait },
          }}
          id="wait"
          type="action"
          {...requiredNodeProps}
        />
      ),
      zoom: 0.3,
    });

    const mark = view.getByRole("status", { name: "Waiting" });
    expect(mark.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-clock"
    );
    expect(
      leadRow(view.container)?.querySelector("svg")?.getAttribute("class")
    ).toContain("lucide-hourglass");
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
