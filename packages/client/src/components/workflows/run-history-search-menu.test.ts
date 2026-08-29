import { describe, expect, it } from "vitest";
import {
  buildRunHistoryMenuItems,
  runHistoryMenuHeading,
  runHistorySearchPlaceholder,
} from "#src/components/workflows/run-history-search-menu";

const catalog = {
  workflows: [
    { id: "wf_1", name: "Onboarding" },
    { id: "wf_2", name: "New Workflow" },
  ],
  eventSuggestions: ["user.created"],
  entitySuggestions: ["user_1"],
};

describe("buildRunHistoryMenuItems", () => {
  it("offers a workflow shortcut instead of the typed fragment", () => {
    const items = buildRunHistoryMenuItems({
      draft: { step: "field" },
      query: "new wor",
      ...catalog,
    });

    expect(items.map((item) => item.id)).toEqual([
      "shortcut:workflow:wf_2",
      "search",
    ]);
    expect(items[0]?.ghost).toBe("kflow");
    expect(items[0]?.action).toEqual({
      type: "commit",
      field: "workflow",
      operator: "is",
      value: "wf_2",
      valueLabel: "New Workflow",
    });
  });

  it("lists matching workflow names on the value step", () => {
    const items = buildRunHistoryMenuItems({
      draft: { step: "value", field: "workflow", operator: "is" },
      query: "new wor",
      ...catalog,
    });

    expect(items.map((item) => item.label)).toEqual(["New Workflow"]);
    expect(items.some((item) => item.id === "value:typed")).toBe(false);
  });

  it("allows a typed fragment only on contains fields with no match", () => {
    const items = buildRunHistoryMenuItems({
      draft: { step: "value", field: "event", operator: "contains" },
      query: "invoice",
      ...catalog,
    });

    expect(items).toEqual([
      {
        id: "value:typed",
        label: "invoice",
        detail: "Event contains",
        icon: "search",
        action: {
          type: "commit",
          field: "event",
          operator: "contains",
          value: "invoice",
        },
      },
    ]);
  });
});

describe("buildRunHistoryMenuItems for the Graph field", () => {
  it("offers Draft and Published on the value step", () => {
    const items = buildRunHistoryMenuItems({
      draft: { step: "value", field: "graph", operator: "is" },
      query: "",
      ...catalog,
    });

    expect(items.map((item) => item.label)).toEqual(["Draft", "Published"]);
  });
});

describe("runHistorySearchPlaceholder", () => {
  it("names the step the input is on", () => {
    expect(runHistorySearchPlaceholder({ step: "field" }, 0)).toBe(
      "Search runs…"
    );
    expect(runHistorySearchPlaceholder({ step: "field" }, 1)).toBe(
      "Add a filter or search…"
    );
    expect(
      runHistorySearchPlaceholder({ step: "operator", field: "status" }, 0)
    ).toBe("Status…");
    expect(
      runHistorySearchPlaceholder(
        { step: "value", field: "workflow", operator: "is" },
        0
      )
    ).toBe("Workflow is…");
  });
});

describe("runHistoryMenuHeading", () => {
  it("is blank on the field step and names the draft after that", () => {
    expect(runHistoryMenuHeading({ step: "field" })).toBeNull();
    expect(runHistoryMenuHeading({ step: "operator", field: "status" })).toBe(
      "Status"
    );
    expect(
      runHistoryMenuHeading({
        step: "value",
        field: "workflow",
        operator: "is",
      })
    ).toBe("Workflow is");
  });
});
