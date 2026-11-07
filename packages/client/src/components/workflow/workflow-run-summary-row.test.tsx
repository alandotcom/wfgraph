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
  scheduledFor: null,
  scheduleDescription: null,
  status: "completed",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  activity: null,
};

describe("WorkflowRunSummaryRow", () => {
  it("uses the start event as the run identity and keeps the run number secondary", () => {
    const onClick = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{ ...BASE_EXECUTION, entityValue: "appt_42" }}
        onClick={onClick}
        runNumber={12}
      />
    );

    const row = view.getByTestId("workflow-run-summary-row");
    expect(view.getByText("appointment.updated")).toBeTruthy();
    expect(view.getByText("appt_42")).toBeTruthy();
    expect(view.getByText(/Run #12/)).toBeTruthy();
    expect(view.getByText("v7 · Test")).toBeTruthy();

    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The row measures the wait from the server's clock in its own answer,
  // which was three minutes past due when the list arrived.
  it("says what the executor is doing in place of the status word", () => {
    const receivedAtMs = Date.now();
    const execution: WorkflowExecution = {
      ...BASE_EXECUTION,
      status: "running",
      activity: {
        kind: "unclaimed",
        dueSince: "2026-02-22T10:00:00.000Z",
        observedAt: "2026-02-22T10:03:00.000Z",
        overdueAfterMs: 60_000,
      },
    };
    const view = render(
      <WorkflowRunSummaryRow
        execution={execution}
        receivedAtMs={receivedAtMs}
        runNumber={2}
      />
    );

    expect(view.getByText("Unclaimed for 3 min").className).toContain(
      "text-warning"
    );
    expect(view.queryByText("Running")).toBeNull();

    // Rows kept from an earlier answer have no arrival time to measure from,
    // so they keep their status word.
    view.rerender(
      <WorkflowRunSummaryRow
        execution={execution}
        receivedAtMs={null}
        runNumber={2}
      />
    );
    expect(view.queryByText(/Unclaimed/)).toBeNull();
    expect(view.getByText("Running")).toBeTruthy();
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

  it("shows the schedule that started a scheduled run under its title in the list and the overview", () => {
    const scheduled: WorkflowExecution = {
      ...BASE_EXECUTION,
      entityValue: "workflow:wf_1",
      startEventName: null,
      startSource: "schedule",
      scheduledFor: BASE_EXECUTION.startedAt,
      scheduleDescription: "Every weekday at 9:00 AM (America/New_York)",
    };

    const row = render(
      <WorkflowRunSummaryRow execution={scheduled} runNumber={4} />
    );
    expect(row.getByText("Scheduled run")).toBeTruthy();
    expect(
      row.getByText("Every weekday at 9:00 AM (America/New_York)")
    ).toBeTruthy();
    row.unmount();

    const header = render(
      <WorkflowRunSummaryRow
        execution={scheduled}
        runNumber={4}
        variant="header"
      />
    );
    // One is the row's label and the other is the Source row's value.
    expect(header.getAllByText("Schedule")).toHaveLength(2);
    expect(
      header.getByText("Every weekday at 9:00 AM (America/New_York)")
    ).toBeTruthy();
    expect(header.queryByText("Entity")).toBeNull();
  });

  it("labels the line beneath a run's title by what it names", () => {
    expect(
      getRunIdentity({ ...BASE_EXECUTION, entityValue: "appt_42" }, 1)
    ).toEqual({
      title: "appointment.updated",
      context: "appt_42",
      contextLabel: "Entity",
    });
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          entityValue: "workflow:wf_1",
          startEventName: null,
          startSource: "schedule",
          scheduleDescription: "Every day at 9:00 AM (UTC)",
        },
        1
      )
    ).toEqual({
      title: "Scheduled run",
      context: "Every day at 9:00 AM (UTC)",
      contextLabel: "Schedule",
    });
  });

  it("titles a scheduled run by its source, not the workflow's own Entity Value", () => {
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          entityValue: "workflow:wf_1",
          startEventName: null,
          startSource: "schedule",
          scheduleDescription: null,
        },
        8
      )
    ).toEqual({ title: "Scheduled run", context: null });
  });

  it("shows a scheduled run's slot beside its start only when the run started more than a minute late", () => {
    const scheduled: WorkflowExecution = {
      ...BASE_EXECUTION,
      entityValue: "workflow:wf_1",
      startEventName: null,
      startSource: "schedule",
    };
    const format = (value: Date) =>
      value.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    const slot = new Date("2026-02-22T09:00:00Z");

    const late = render(
      <WorkflowRunSummaryRow
        execution={{ ...scheduled, scheduledFor: slot }}
        runNumber={3}
        variant="header"
      />
    );
    expect(late.getByText("Scheduled run")).toBeTruthy();
    expect(late.getByText("Scheduled")).toBeTruthy();
    expect(late.getByText(format(slot))).toBeTruthy();
    expect(late.getByText(format(BASE_EXECUTION.startedAt))).toBeTruthy();
    late.unmount();

    // Thirty seconds is a worker claiming a due timer, not a late start.
    const onTime = render(
      <WorkflowRunSummaryRow
        execution={{
          ...scheduled,
          scheduledFor: new Date("2026-02-22T09:59:30Z"),
          scheduleDescription: null,
        }}
        runNumber={3}
        variant="header"
      />
    );
    expect(onTime.queryByText("Scheduled")).toBeNull();
    expect(onTime.getByText("Started")).toBeTruthy();
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
      retries: 0,
      retryLimit: 4,
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
    // A node with a step the executor will run again reads as retrying while
    // the run is in progress, and as its own status once the run has ended.
    expect(
      getRunOutcome(
        { ...BASE_EXECUTION, status: "running", duration: null },
        [failedLog],
        ["send_1"]
      )
    ).toBe("Retrying Send confirmation");
    expect(
      getRunOutcome(
        { ...BASE_EXECUTION, status: "failed" },
        [failedLog],
        ["send_1"]
      )
    ).toBe("Failed at Send confirmation");
    expect(getRunOutcome({ ...BASE_EXECUTION, status: "superseded" }, [])).toBe(
      "Replaced by a newer start"
    );
    expect(getRunOutcome({ ...BASE_EXECUTION, status: "exited" }, [])).toBe(
      "Exited by Entity eligibility"
    );
  });

  it("shows a compact header with a visible cancel action", () => {
    const onCancel = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          status: "waiting",
          startEventName: "app/appointment.created.with.a.very.long.path",
        }}
        onCancel={onCancel}
        outcome="Waiting at Hold until appointment"
        runNumber={2}
        variant="header"
      />
    );

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
