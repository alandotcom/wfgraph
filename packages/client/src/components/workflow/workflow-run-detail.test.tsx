import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { WorkflowRunDetail } from "./workflow-run-detail";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: null,
  entityValue: null,
  duration: null,
  error: null,
  id: "exec_1",
  runMode: "test",
  startedAt: new Date("2026-02-22T10:00:00Z"),
  status: "running",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  workflowRunId: "run_1",
};

/** The props every case shares, so a case only names what it varies. */
function renderDetail(execution: WorkflowExecution) {
  return render(
    <WorkflowRunDetail
      execution={execution}
      events={[]}
      isCanceling={false}
      isResuming={false}
      logs={[]}
      onBack={vi.fn(() => undefined)}
      onCancel={vi.fn(() => undefined)}
      onResume={vi.fn(() => undefined)}
      runNumber={1}
      waits={[]}
    />
  );
}

describe("WorkflowRunDetail", () => {
  // A Lifecycle Rules Cancel Event reaches every in-flight status (ADR-0007),
  // so the manual button reaches the same ground: a run standing on an
  // ordinary node, not just one parked on a Wait.
  it("shows the cancel button for a running execution", () => {
    const view = renderDetail(BASE_EXECUTION);

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows the cancel button for a pending execution", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "pending" });

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("still shows the cancel button for a waiting execution", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "waiting" });

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides the cancel button once the run has finished", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "completed" });

    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
