import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: new Date("2026-02-22T10:01:00Z"),
  entityValue: null,
  duration: "1200",
  error: null,
  id: "exec_1",
  runMode: "test",
  startedAt: new Date("2026-02-22T10:00:00Z"),
  status: "completed",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  workflowRunId: "run_1",
};

describe("WorkflowRunSummaryRow", () => {
  it("renders a wrapping list row without a cancel gutter", () => {
    const onClick = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={BASE_EXECUTION}
        onClick={onClick}
        runNumber={1}
        selected
      />
    );

    const row = view.getByTestId("workflow-run-summary-row");
    expect(row.className).not.toContain(
      "grid-cols-[1.5rem_minmax(0,1fr)_5rem]"
    );
    expect(row.className).toContain("py-2.5");
    expect(row.className).toContain("bg-muted");
    expect(view.getByText("Test")).toBeTruthy();
    expect(view.queryByText("Test Mode")).toBeNull();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stacks header metadata so a long event name wraps on its own line", () => {
    const onBack = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          startEventName: "app/appointment.created.with.a.very.long.path",
        }}
        onBack={onBack}
        runNumber={2}
        variant="header"
      />
    );

    const backButton = view.getByRole("button", { name: "Back to runs list" });
    fireEvent.click(backButton);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(
      view.getByText("app/appointment.created.with.a.very.long.path")
    ).toBeTruthy();
    expect(
      view.getByTestId("workflow-run-summary-row").className
    ).not.toContain("5rem");
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders a full-width cancel button only while the run can still stop", () => {
    const onCancel = vi.fn(() => undefined);
    const waitingExecution: WorkflowExecution = {
      ...BASE_EXECUTION,
      id: "exec_waiting",
      status: "waiting",
      waitingAt: new Date("2026-02-22T10:01:00Z"),
    };

    const view = render(
      <WorkflowRunSummaryRow
        execution={waitingExecution}
        isCanceling={false}
        onBack={vi.fn(() => undefined)}
        onCancel={onCancel}
        runNumber={3}
        variant="header"
      />
    );

    const cancelButton = view.getByRole("button", { name: "Cancel" });
    expect(cancelButton.className).toContain("w-full");
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledWith("exec_waiting");
  });
});
