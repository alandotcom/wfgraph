import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHistoryTable } from "#src/components/workflows/run-history-table";
import type { RunHistoryTableRow } from "#src/components/workflows/run-history-table";

function run(
  overrides: Partial<RunHistoryTableRow> & { id: string }
): RunHistoryTableRow {
  return {
    workflowId: "wf_1",
    workflowName: "Onboarding",
    workflowIsPaused: false,
    status: "completed",
    startSource: "manual",
    runMode: "live",
    startEventName: null,
    entityValue: null,
    workflowRunId: null,
    versionKind: "published",
    versionNumber: 4,
    error: null,
    startedAt: "2026-08-22T10:00:00.000Z",
    waitingAt: null,
    cancelledAt: null,
    completedAt: "2026-08-22T10:00:01.000Z",
    duration: "1000",
    ...overrides,
  };
}

const ROWS: RunHistoryTableRow[] = [
  run({
    id: "exec_1",
    workflowName: "Onboarding",
    status: "failed",
    startEventName: "user.created",
  }),
  run({
    id: "exec_2",
    workflowId: "wf_2",
    workflowName: "Billing",
    status: "running",
    runMode: "test",
    startedAt: "2026-08-22T09:00:00.000Z",
    duration: "500",
  }),
  run({
    id: "exec_3",
    workflowId: "wf_3",
    workflowName: "Reminder",
    status: "completed",
    runMode: "test",
    versionKind: "draft_snapshot",
    versionNumber: null,
    startedAt: "2026-08-22T08:00:00.000Z",
    duration: "700",
  }),
];

describe("RunHistoryTable", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 800;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
      toJSON() {
        return {};
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders column headers and row content", () => {
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={() => undefined}
        runs={ROWS}
      />
    );

    expect(view.getByRole("button", { name: "Workflow" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Status" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Graph" })).toBeTruthy();
    expect(view.getByText("Onboarding")).toBeTruthy();
    expect(view.getByText("Billing")).toBeTruthy();
    expect(view.getByText("Failed")).toBeTruthy();
    // Billing and the draft-snapshot row are both test-mode runs.
    expect(view.getAllByText("Test")).toHaveLength(2);
    // Onboarding and Billing both pin to published version 4.
    expect(view.getAllByText("v4")).toHaveLength(2);
  });

  it("labels a draft-snapshot run's row as Draft in the Graph column", () => {
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={() => undefined}
        runs={ROWS}
      />
    );

    // Only the draft-snapshot run (exec_3, "Reminder") gets the label; the
    // published-graph test run (exec_2, "Billing") names its version instead.
    expect(view.getByText("Draft")).toBeTruthy();
    expect(view.getAllByText("Draft")).toHaveLength(1);
  });

  it("orders the Graph column by the version number it prints", () => {
    // v11 sorts above v4 by number and below it by string, and the draft
    // snapshot carries no number at all, so the three settle the question of
    // what the header sorts on.
    const rows = [
      run({ id: "exec_a", workflowName: "Eleven", versionNumber: 11 }),
      run({
        id: "exec_b",
        workflowName: "Canvas",
        versionKind: "draft_snapshot",
        versionNumber: null,
      }),
      run({ id: "exec_c", workflowName: "Four", versionNumber: 4 }),
    ];
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={() => undefined}
        runs={rows}
      />
    );

    const graphCells = () =>
      [...view.container.querySelectorAll("span")]
        .map((cell) => cell.textContent ?? "")
        .filter((label) => label === "Draft" || label.startsWith("v"));

    // A numbered column opens on its highest value, as Duration does.
    fireEvent.click(view.getByRole("button", { name: "Graph" }));
    expect(graphCells()).toEqual(["v11", "v4", "Draft"]);
    fireEvent.click(view.getByRole("button", { name: "Graph" }));
    expect(graphCells()).toEqual(["Draft", "v4", "v11"]);
  });

  it("opens a run from the workflow name", () => {
    const onOpenRun = vi.fn(() => undefined);
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={onOpenRun}
        runs={ROWS}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Onboarding" }));
    expect(onOpenRun).toHaveBeenCalledWith(ROWS[0]);
  });

  it("sorts by started time when the column header is clicked", () => {
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={() => undefined}
        runs={ROWS}
      />
    );

    const names = () =>
      [...view.container.querySelectorAll("button")]
        .map((button) => button.textContent ?? "")
        .filter((label) => label === "Onboarding" || label === "Billing");

    expect(names()[0]).toContain("Onboarding");
    fireEvent.click(view.getByRole("button", { name: "Started" }));
    expect(names()[0]).toContain("Billing");
  });

  it("shows the empty copy when there is nothing to list", () => {
    const view = render(
      <RunHistoryTable
        hasNextPage={false}
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenRun={() => undefined}
        runs={[]}
      />
    );

    expect(view.getByText("No runs found.")).toBeTruthy();
  });

  it("offers next and load more when another page exists", () => {
    const onLoadMore = vi.fn(() => undefined);
    const view = render(
      <RunHistoryTable
        hasNextPage
        isLoading={false}
        isLoadingMore={false}
        onLoadMore={onLoadMore}
        onOpenRun={() => undefined}
        runs={ROWS}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
