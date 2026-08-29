import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import {
  getRunIdentity,
  getRunOutcome,
  WorkflowRunSummaryRow,
} from "./workflow-run-summary-row";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: new Date("2026-02-22T10:01:00Z"),
  entityValue: null,
  duration: "1200",
  error: null,
  id: "exec_1",
  runMode: "test",
  versionKind: "published",
  versionNumber: 7,
  startedAt: new Date("2026-02-22T10:00:00Z"),
  status: "completed",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  workflowRunId: "run_1",
};

describe("WorkflowRunSummaryRow", () => {
  it("uses the start event as the run identity and keeps the run number secondary", () => {
    const onClick = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{ ...BASE_EXECUTION, entityValue: "appt_42" }}
        onClick={onClick}
        runNumber={12}
        selected
      />
    );

    const row = view.getByTestId("workflow-run-summary-row");
    expect(view.getByText("appointment.updated")).toBeTruthy();
    expect(view.getByText("appt_42")).toBeTruthy();
    expect(view.getByText(/Run #12/)).toBeTruthy();
    expect(row.className).toContain("bg-muted");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(view.getByText("v7 · Test")).toBeTruthy();

    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // A draft-snapshot run pinned a graph that was never published, so its label
  // must read differently from an ordinary test run.
  it("labels a draft-snapshot run as Draft in the list", () => {
    const view = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          versionKind: "draft_snapshot",
          versionNumber: null,
        }}
        runNumber={3}
      />
    );

    expect(view.getByText("Draft · Test")).toBeTruthy();
  });

  it("shows no Draft label for a published-graph run", () => {
    const view = render(
      <WorkflowRunSummaryRow execution={BASE_EXECUTION} runNumber={3} />
    );

    expect(view.queryByText("Draft")).toBeNull();
    expect(view.getByText("v7 · Test")).toBeTruthy();
  });

  it("shows the run's graph and recipients in the header's metadata", () => {
    const draftView = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          versionKind: "draft_snapshot",
          versionNumber: null,
        }}
        runNumber={3}
        variant="header"
      />
    );

    expect(draftView.getByText("Graph")).toBeTruthy();
    expect(draftView.getByText("Draft")).toBeTruthy();
    expect(draftView.getByText("Recipients")).toBeTruthy();
    expect(draftView.getByText("Test")).toBeTruthy();

    const publishedView = render(
      <WorkflowRunSummaryRow
        execution={{ ...BASE_EXECUTION, runMode: "live" }}
        runNumber={3}
        variant="header"
      />
    );

    expect(publishedView.getByText("Published v7")).toBeTruthy();
    expect(publishedView.getByText("Live")).toBeTruthy();
  });

  it("uses meaningful fallbacks for starts that have no event", () => {
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          startEventName: null,
          startSource: "schedule",
        },
        8
      ).title
    ).toBe("Scheduled run");
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          startEventName: null,
          startSource: "manual",
        },
        8
      ).title
    ).toBe("Manual run");
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          entityValue: "customer_7",
          startEventName: null,
          startSource: null,
        },
        8
      ).title
    ).toBe("customer_7");
  });

  it("labels an eventless manual run instead of its internal workflow entity", () => {
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          entityValue: "workflow:wf_1",
          startEventName: null,
          startSource: "manual",
        },
        8
      )
    ).toEqual({ title: "Manual run", context: null });
  });

  it("keeps a correlated workflow entity as the run title", () => {
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          entityValue: "workflow:customer_7",
          startEventName: null,
          startSource: "manual",
        },
        8
      )
    ).toEqual({ title: "workflow:customer_7", context: null });
  });

  it("describes terminal and active outcomes from the execution logs", () => {
    const failedLog = {
      id: "log_1",
      nodeId: "send_1",
      nodeName: "Send confirmation",
      nodeType: "action",
      status: "error" as const,
      startedAt: new Date("2026-02-22T10:00:00Z"),
      completedAt: new Date("2026-02-22T10:00:01Z"),
      duration: "1000",
      error: "Request failed",
    };

    expect(
      getRunOutcome({ ...BASE_EXECUTION, status: "failed" }, [failedLog])
    ).toBe("Failed at Send confirmation");
    expect(getRunOutcome({ ...BASE_EXECUTION, status: "completed" }, [])).toBe(
      "Completed in 1.20s"
    );
    expect(
      getRunOutcome({ ...BASE_EXECUTION, status: "running", duration: null }, [
        { ...failedLog, nodeName: "Send reminder", status: "running" },
      ])
    ).toBe("Running Send reminder");
    expect(getRunOutcome({ ...BASE_EXECUTION, status: "superseded" }, [])).toBe(
      "Replaced by a newer start"
    );
  });

  it("shows a compact header with a visible cancel action", () => {
    const onBack = vi.fn(() => undefined);
    const onCancel = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          status: "waiting",
          startEventName: "app/appointment.created.with.a.very.long.path",
        }}
        onBack={onBack}
        onCancel={onCancel}
        outcome="Waiting at Hold until appointment"
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
    expect(view.getByText("Waiting at Hold until appointment")).toBeTruthy();
    const cancelButton = view.getByRole("button", { name: "Cancel" });
    expect(cancelButton.className).not.toContain("w-full");
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledWith("exec_1");
  });
});
