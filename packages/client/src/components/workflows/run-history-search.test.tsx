import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { RunHistorySearch } from "#src/components/workflows/run-history-search";
import type { RunFilter } from "#src/lib/run-history-filters";

function Harness({ resultCount = 4 }: { resultCount?: number }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<RunFilter[]>([]);

  return (
    <RunHistorySearch.Provider
      entitySuggestions={["user_1"]}
      eventSuggestions={["user.created"]}
      filters={filters}
      onFiltersChange={setFilters}
      onQueryChange={setQuery}
      query={query}
      resultCount={resultCount}
      workflows={[
        { id: "wf_1", name: "Onboarding" },
        { id: "wf_2", name: "New Workflow" },
      ]}
    >
      <RunHistorySearch.Root>
        <RunHistorySearch.Frame>
          <RunHistorySearch.Pills />
          <RunHistorySearch.Input />
          <RunHistorySearch.ResultCount />
        </RunHistorySearch.Frame>
        <RunHistorySearch.Menu />
      </RunHistorySearch.Root>
    </RunHistorySearch.Provider>
  );
}

describe("RunHistorySearch", () => {
  it("opens field choices when the search is focused", () => {
    const view = render(<Harness />);
    fireEvent.focus(
      view.getByRole("combobox", { name: "Search and filter runs" })
    );

    expect(view.getByRole("option", { name: "Status" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Workflow" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Mode" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Source" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Event" })).toBeTruthy();
    expect(view.getByRole("option", { name: "Entity" })).toBeTruthy();
    expect(view.getByText("4 results")).toBeTruthy();
  });

  it("builds a status filter pill through field, operator, and value", () => {
    const view = render(<Harness />);
    fireEvent.focus(
      view.getByRole("combobox", { name: "Search and filter runs" })
    );
    fireEvent.click(view.getByRole("option", { name: "Status" }));
    fireEvent.click(view.getByRole("option", { name: "Status is" }));
    fireEvent.click(view.getByRole("option", { name: "Failed" }));

    expect(
      view.getByRole("button", { name: "Remove Status is Failed" })
    ).toBeTruthy();
    expect(view.getByText("Failed")).toBeTruthy();
  });

  it("removes a pill from its button", () => {
    const view = render(<Harness />);
    fireEvent.focus(
      view.getByRole("combobox", { name: "Search and filter runs" })
    );
    fireEvent.click(view.getByRole("option", { name: "Mode" }));
    fireEvent.click(view.getByRole("option", { name: "Mode is" }));
    fireEvent.click(view.getByRole("option", { name: "Test" }));

    fireEvent.click(view.getByRole("button", { name: "Remove Mode is Test" }));

    expect(
      view.queryByRole("button", { name: "Remove Mode is Test" })
    ).toBeNull();
  });

  it("narrows field choices as the query is typed", () => {
    const view = render(<Harness />);
    const input = view.getByRole("combobox", {
      name: "Search and filter runs",
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "stat" } });

    expect(view.getByRole("option", { name: "Status" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Workflow" })).toBeNull();
    expect(
      view.getByRole("option", { name: "Search runs for “stat”" })
    ).toBeTruthy();
  });

  it("autofills a workflow name from the first letters", () => {
    const view = render(<Harness />);
    const input = view.getByRole("combobox", {
      name: "Search and filter runs",
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "new wor" } });

    expect(view.getByRole("option", { name: /New Workflow/ })).toBeTruthy();
    expect(
      view.queryByRole("option", { name: /Workflow is new wor/ })
    ).toBeNull();
    expect(view.getByText("kflow")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab" });

    expect(
      view.getByRole("button", { name: "Remove Workflow is New Workflow" })
    ).toBeTruthy();
  });

  it("does not offer the typed fragment as a workflow value", () => {
    const view = render(<Harness />);
    fireEvent.focus(
      view.getByRole("combobox", { name: "Search and filter runs" })
    );
    fireEvent.click(view.getByRole("option", { name: "Workflow" }));
    fireEvent.click(view.getByRole("option", { name: "Workflow is" }));
    fireEvent.change(
      view.getByRole("combobox", { name: "Search and filter runs" }),
      { target: { value: "new wor" } }
    );

    expect(view.getByRole("option", { name: "New Workflow" })).toBeTruthy();
    expect(
      view.queryByRole("option", { name: /Workflow is new wor/ })
    ).toBeNull();
  });
});
