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
    expect(view.getByText("Onboarding")).toBeTruthy();
    expect(view.getByText("Billing")).toBeTruthy();
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByText("Test")).toBeTruthy();
  });

  it("opens a run when the row is clicked", () => {
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

    fireEvent.click(view.getByRole("button", { name: "Open Onboarding run" }));
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
      view
        .getAllByRole("button", { name: /Open .+ run/ })
        .map((button) => button.textContent ?? "");

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
