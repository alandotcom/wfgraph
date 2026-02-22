import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import type { WorkflowExecution } from "./workflow-run-shared";
import { WorkflowRunSummaryRow } from "./workflow-run-summary-row";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: new Date("2026-02-22T10:01:00Z"),
  correlationKey: null,
  duration: "1200",
  error: null,
  id: "exec_1",
  isDryRun: true,
  startedAt: new Date("2026-02-22T10:00:00Z"),
  status: "success",
  triggerEventType: "appointment.updated",
  triggerType: "webhook",
  waitingAt: null,
  workflowId: "wf_1",
  workflowRunId: "run_1",
};

describe("WorkflowRunSummaryRow", () => {
  it("renders list mode with fixed layout and click behavior", () => {
    const onClick = mock(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={BASE_EXECUTION}
        leading={{ type: "spacer" }}
        onClick={onClick}
        runNumber={1}
        selected
        trailing={{ type: "spacer" }}
      />
    );

    const row = view.getByTestId("workflow-run-summary-row");
    expect(row.className).toContain("grid-cols-[1.5rem_minmax(0,1fr)_5rem]");
    expect(row.className).toContain("py-3");
    expect(row.className).toContain("bg-muted/50");

    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders back button in detail mode", () => {
    const onBack = mock(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={BASE_EXECUTION}
        leading={{ onBack, type: "back" }}
        runNumber={2}
        showTriggerEventType
        trailing={{ type: "spacer" }}
      />
    );

    const backButton = view.getByRole("button", { name: "Back to runs list" });
    fireEvent.click(backButton);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(view.getByText("appointment.updated")).toBeTruthy();
  });

  it("renders cancel button for waiting runs", () => {
    const onCancel = mock(() => undefined);
    const waitingExecution: WorkflowExecution = {
      ...BASE_EXECUTION,
      id: "exec_waiting",
      status: "waiting",
      waitingAt: new Date("2026-02-22T10:01:00Z"),
    };

    const view = render(
      <WorkflowRunSummaryRow
        execution={waitingExecution}
        leading={{ onBack: mock(() => undefined), type: "back" }}
        runNumber={3}
        trailing={{ isCanceling: false, onCancel, type: "cancel" }}
      />
    );

    const cancelButton = view.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledWith("exec_waiting");
  });
});
