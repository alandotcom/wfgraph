import { cleanup, fireEvent, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { WorkflowSummaryCard } from "#src/components/workflow/workflow-summary-card";
import { edgesStateAtom, nodesStateAtom } from "#src/lib/workflow-graph-cells";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";

afterEach(() => {
  cleanup();
});

const catalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  events: [
    { name: "app/booked", label: "Appointment created", payloadFields: [] },
    { name: "app/canceled", label: "Appointment canceled", payloadFields: [] },
  ],
};

const nodes: WorkflowNode[] = [
  {
    id: "entry",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Booked",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/booked"],
          cancelEvents: ["app/canceled"],
          concurrency: "unlimited",
        },
      },
    },
  },
  {
    id: "confirm",
    type: "action",
    position: { x: 0, y: 200 },
    data: { label: "Send booking confirmation", type: "action", config: {} },
  },
];

function renderCard() {
  const store = createStore();
  store.set(nodesStateAtom, nodes);
  store.set(edgesStateAtom, [
    { id: "e", source: "entry", sourceHandle: "started", target: "confirm" },
  ]);
  return render(
    <Provider store={store}>
      <ExtensionCatalogProvider value={catalog}>
        <WorkflowSummaryCard />
      </ExtensionCatalogProvider>
    </Provider>
  );
}

describe("WorkflowSummaryCard", () => {
  it("shows what starts a run while collapsed, and the whole account once expanded", () => {
    const view = renderCard();
    const toggle = view.getByRole("button", {
      name: "What this workflow does",
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      view.getByText("Starts when Appointment created arrives.")
    ).toBeTruthy();
    expect(view.queryByText("Send booking confirmation")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("Send booking confirmation")).toBeTruthy();
    expect(
      view.getByText("Appointment canceled stops a run in progress.")
    ).toBeTruthy();
  });

  it("keeps a 44px toggle on a phone", () => {
    const view = renderCard();

    expect(
      view.getByRole("button", { name: "What this workflow does" }).className
    ).toContain("h-11");
  });
});
