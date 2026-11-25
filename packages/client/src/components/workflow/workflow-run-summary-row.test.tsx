import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as renderWithoutCatalog,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { runShortId } from "#src/lib/workflow-run-labels";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { formatExactTime } from "@wfgraph/shared/utils/time";
import {
  getRunIdentity,
  getRunOutcome,
  runTitle,
  WorkflowRunSummaryRow,
} from "./workflow-run-summary-row";

const catalog: ExtensionCatalog = {
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [],
      stateSchemaDigest: "digest",
    },
  ],
  events: [
    {
      name: "appointment.updated",
      label: "Appointment updated",
      payloadFields: [],
    },
  ],
  actions: [],
  integrations: [],
};

/** Renders `ui` inside the catalog the run titles are read from. */
function render(ui: ReactElement) {
  return renderWithoutCatalog(ui, {
    wrapper: ({ children }) => (
      <ExtensionCatalogProvider value={catalog}>
        {children}
      </ExtensionCatalogProvider>
    ),
  });
}

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: new Date("2026-02-22T10:01:00Z"),
  entityValue: null,
  entity: null,
  duration: "1200",
  error: null,
  id: "01a212fa-dd29-736c-9eb8-a0d40e3f6303",
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
  it("titles a run by its Entity, with its Event's label and start time beneath and no id", () => {
    const onClick = vi.fn(() => undefined);
    const view = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          entity: { type: "patient", id: "pat_20418" },
        }}
        onClick={onClick}
      />
    );

    const row = view.getByTestId("workflow-run-summary-row");
    const [title, startedBy] = row.querySelectorAll("p");
    expect(title?.textContent).toBe("Patient pat_20418");
    expect(startedBy?.textContent).toBe(
      `Appointment updated·${formatExactTime(BASE_EXECUTION.startedAt)}`
    );
    expect(view.queryByText(runShortId(BASE_EXECUTION.id))).toBeNull();
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
      />
    );

    expect(view.getByText("Unclaimed for 3 min").className).toContain(
      "text-warning"
    );
    expect(view.queryByText("Running")).toBeNull();

    // Rows kept from an earlier answer have no arrival time to measure from,
    // so they keep their status word.
    view.rerender(
      <WorkflowRunSummaryRow execution={execution} receivedAtMs={null} />
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
      />
    );

    expect(view.getByText("Draft · Test")).toBeTruthy();
  });

  it("shows no Draft label for a published-graph run", () => {
    const view = render(<WorkflowRunSummaryRow execution={BASE_EXECUTION} />);

    expect(view.queryByText("Draft")).toBeNull();
    expect(view.getByText("v7 · Test")).toBeTruthy();
  });

  // The header names the version and Published mode in one Version row, in
  // the words the run list, the All Runs Version column and the Run control use.
  it("shows the run's version and mode in one Version row of the header", () => {
    const draftView = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          versionKind: "draft_snapshot",
          versionNumber: null,
        }}
        variant="header"
      />
    );

    expect(draftView.getByText("Version")).toBeTruthy();
    expect(draftView.getByText("Draft · Test")).toBeTruthy();
    expect(draftView.queryByText("Graph")).toBeNull();
    expect(draftView.queryByText("Recipients")).toBeNull();

    const publishedView = render(
      <WorkflowRunSummaryRow
        execution={{ ...BASE_EXECUTION, runMode: "live" }}
        variant="header"
      />
    );

    expect(publishedView.getByText("v7 · Live")).toBeTruthy();
  });

  it("uses meaningful fallbacks for starts that have no event", () => {
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          startEventName: null,
          startSource: "schedule",
        },
        catalog
      ).title
    ).toBe("Scheduled run");
    expect(
      getRunIdentity(
        {
          ...BASE_EXECUTION,
          startEventName: null,
          startSource: "manual",
        },
        catalog
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
        catalog
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

    const row = render(<WorkflowRunSummaryRow execution={scheduled} />);
    expect(row.getByText("Scheduled run")).toBeTruthy();
    expect(
      row.getByText("Every weekday at 9:00 AM (America/New_York)")
    ).toBeTruthy();
    row.unmount();

    const header = render(
      <WorkflowRunSummaryRow execution={scheduled} variant="header" />
    );
    // One is the row's label and the other is the Source row's value.
    expect(header.getAllByText("Schedule")).toHaveLength(2);
    expect(
      header.getByText("Every weekday at 9:00 AM (America/New_York)")
    ).toBeTruthy();
    expect(header.queryByText("Entity")).toBeNull();
  });

  it("names a tracked run by its Entity's label and id, and by its type when the catalog no longer declares it", () => {
    const tracked = {
      ...BASE_EXECUTION,
      entity: { type: "patient", id: "pat_20418" },
    };
    expect(getRunIdentity(tracked, catalog)).toEqual({
      title: "Patient pat_20418",
      startedBy: "Appointment updated",
      event: { name: "appointment.updated", label: "Appointment updated" },
      schedule: null,
    });
    expect(runTitle(tracked, catalog)).toBe(
      `Patient pat_20418 · ${formatExactTime(BASE_EXECUTION.startedAt)}`
    );
    expect(
      getRunIdentity(
        { ...tracked, entity: { type: "clinic", id: "cl_7" } },
        catalog
      ).title
    ).toBe("clinic cl_7");
  });

  it("names a run of an untracked workflow by its Entity Value, and a run with neither by its Event", () => {
    expect(
      getRunIdentity({ ...BASE_EXECUTION, entityValue: "appt_42" }, catalog)
    ).toEqual({
      title: "appt_42",
      startedBy: "Appointment updated",
      event: { name: "appointment.updated", label: "Appointment updated" },
      schedule: null,
    });
    expect(getRunIdentity(BASE_EXECUTION, catalog)).toEqual({
      title: "Appointment updated",
      startedBy: null,
      event: { name: "appointment.updated", label: "Appointment updated" },
      schedule: null,
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
        catalog
      )
    ).toEqual({
      title: "Scheduled run",
      startedBy: "Every day at 9:00 AM (UTC)",
      event: null,
      schedule: "Every day at 9:00 AM (UTC)",
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
        catalog
      )
    ).toEqual({
      title: "Scheduled run",
      startedBy: null,
      event: null,
      schedule: null,
    });
  });

  it("shows a scheduled run's slot beside its start only when the run started more than a minute late", () => {
    const scheduled: WorkflowExecution = {
      ...BASE_EXECUTION,
      entityValue: "workflow:wf_1",
      startEventName: null,
      startSource: "schedule",
    };
    const format = (value: Date) => formatExactTime(value);
    const slot = new Date("2026-02-22T09:00:00Z");

    const late = render(
      <WorkflowRunSummaryRow
        execution={{ ...scheduled, scheduledFor: slot }}
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
        catalog
      )
    ).toEqual({
      title: "Manual run",
      startedBy: null,
      event: null,
      schedule: null,
    });
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
        catalog
      )
    ).toEqual({
      title: "workflow:customer_7",
      startedBy: null,
      event: null,
      schedule: null,
    });
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
      "Completed in 1.2s"
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
    expect(onCancel).toHaveBeenCalledWith(BASE_EXECUTION.id);
  });

  // The short id is for a developer, so it is one detail row of the header and
  // never part of a list row.
  it("prints a run's short id in the header's Run row and not in the list", () => {
    const row = render(<WorkflowRunSummaryRow execution={BASE_EXECUTION} />);
    expect(row.queryByText(runShortId(BASE_EXECUTION.id))).toBeNull();
    row.unmount();

    const header = render(
      <WorkflowRunSummaryRow execution={BASE_EXECUTION} variant="header" />
    );
    expect(header.getByText("Run")).toBeTruthy();
    expect(header.getByText(runShortId(BASE_EXECUTION.id))).toBeTruthy();
  });

  it("keeps the Event's machine name beside its label in the header", () => {
    const header = render(
      <WorkflowRunSummaryRow execution={BASE_EXECUTION} variant="header" />
    );

    expect(header.getByRole("heading").textContent).toBe("Appointment updated");
    expect(header.getByText("appointment.updated")).toBeTruthy();
    header.unmount();

    // A run named by its Entity names its Event in the Event row.
    const tracked = render(
      <WorkflowRunSummaryRow
        execution={{
          ...BASE_EXECUTION,
          entity: { type: "patient", id: "pat_20418" },
        }}
        variant="header"
      />
    );
    expect(tracked.getByRole("heading").textContent).toBe("Patient pat_20418");
    expect(
      tracked.getByText("Appointment updated (appointment.updated)")
    ).toBeTruthy();
  });

  it("titles a run whose Event the catalog does not declare by its machine name", () => {
    expect(
      getRunIdentity(
        { ...BASE_EXECUTION, startEventName: "billing/payment.settled" },
        catalog
      ).title
    ).toBe("billing/payment.settled");
  });

  // Most runs finish in milliseconds, so the list prints no duration under a
  // second; the success word reads muted so a failure stands out.
  it("leaves out a sub-second duration and mutes a successful status in the list", () => {
    const view = render(
      <WorkflowRunSummaryRow
        execution={{ ...BASE_EXECUTION, duration: "33" }}
      />
    );

    expect(view.queryByText("<1s")).toBeNull();
    expect(view.getByText("Completed").className).toContain(
      "text-muted-foreground"
    );
  });
});
