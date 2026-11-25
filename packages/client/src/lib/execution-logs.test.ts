import { describe, expect, it } from "vitest";
import {
  logsBehindStatusRead,
  applyExecutionStatusToLogs,
  isRunInProgress,
  shouldPollExecutionDetail,
  toExecutionDetail,
  toExecutionOverlaySource,
  toPinnedRunSummary,
  toWorkflowExecutionFromSummary,
  toWorkflowExecutions,
} from "#src/lib/execution-logs";
import type { ExecutionLogsResult } from "#src/lib/rpc-client";

const rawExecution = {
  id: "exec_1",
  workflowId: "wf_1",
  status: "completed" as const,
  startSource: "event" as const,
  runMode: "live" as const,
  versionKind: "published" as const,
  versionNumber: 3,
  startEventName: "app/appointment.created",
  entityValue: "appt_1",
  entity: null,
  error: null,
  startedAt: "2026-03-01T10:00:00.000Z",
  scheduledFor: null,
  scheduleDescription: null,
  waitingAt: null,
  cancelledAt: null,
  completedAt: "2026-03-01T10:00:05.000Z",
  duration: "5000",
  activity: null,
};

describe("toWorkflowExecutions", () => {
  // Timestamps arrive as ISO strings and are compared and formatted as Dates, so
  // this is where the wire shape becomes the shape every row reads.
  it("keeps the run list and both workflow audit categories", () => {
    const result = toWorkflowExecutions({
      items: [rawExecution],
      observedAt: "2026-03-01T10:00:10.000Z",
      overdueAfterMs: 60_000,
      runRetentionMs: null,
      supersededCount: 3,
      refusedStarts: [
        {
          id: "evt_1",
          message: "Refused a start",
          createdAt: "2026-03-01T09:59:00.000Z",
        },
      ],
      cancelNotDelivered: [
        {
          id: "evt_2",
          message: "The cancel event reached no run",
          createdAt: "2026-03-01T09:58:00.000Z",
        },
      ],
    });

    expect(result.supersededCount).toBe(3);
    expect(result.executions[0]?.startedAt).toEqual(
      new Date("2026-03-01T10:00:00.000Z")
    );
    expect(result.executions[0]?.completedAt).toEqual(
      new Date("2026-03-01T10:00:05.000Z")
    );
    expect(result.refusedStarts[0]?.createdAt).toEqual(
      new Date("2026-03-01T09:59:00.000Z")
    );
    expect(result.cancelNotDelivered[0]?.createdAt).toEqual(
      new Date("2026-03-01T09:58:00.000Z")
    );
  });

  it("reads a scheduled run's slot as a Date, and null for a run no schedule started", () => {
    const result = toWorkflowExecutions({
      items: [
        {
          ...rawExecution,
          id: "exec_scheduled",
          startSource: "schedule",
          startEventName: null,
          entityValue: "workflow:wf_1",
          scheduledFor: "2026-03-01T09:00:00.000Z",
          scheduleDescription: null,
        },
        rawExecution,
      ],
      observedAt: "2026-03-01T10:00:10.000Z",
      overdueAfterMs: 60_000,
      runRetentionMs: null,
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    });

    expect(result.executions.map((run) => run.scheduledFor)).toEqual([
      new Date("2026-03-01T09:00:00.000Z"),
      null,
    ]);
  });

  // The answer carries the server's clock and threshold once, and each row's
  // activity is read against them.
  it("gives a row's activity the reading its answer carries", () => {
    const result = toWorkflowExecutions({
      items: [
        {
          ...rawExecution,
          status: "running",
          completedAt: null,
          activity: { kind: "unclaimed", dueSince: "2026-03-01T10:00:00.000Z" },
        },
      ],
      observedAt: "2026-03-01T10:00:10.000Z",
      overdueAfterMs: 120_000,
      runRetentionMs: null,
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    });

    expect(result.executions[0]?.activity).toEqual({
      kind: "unclaimed",
      dueSince: "2026-03-01T10:00:00.000Z",
      observedAt: "2026-03-01T10:00:10.000Z",
      overdueAfterMs: 120_000,
    });
  });

  // A run that never waited or was cancelled carries nulls, and a Date built from
  // one would be an Invalid Date the row would then format.
  it("leaves an absent timestamp absent", () => {
    const result = toWorkflowExecutions({
      items: [{ ...rawExecution, completedAt: null }],
      observedAt: "2026-03-01T10:00:10.000Z",
      overdueAfterMs: 60_000,
      runRetentionMs: null,
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    });

    expect(result.executions[0]?.waitingAt).toBeNull();
    expect(result.executions[0]?.cancelledAt).toBeNull();
    expect(result.executions[0]?.completedAt).toBeNull();
  });
});

describe("isRunInProgress", () => {
  it("answers for the statuses that can still change", () => {
    expect(isRunInProgress("running")).toBe(true);
    expect(isRunInProgress("waiting")).toBe(true);
    expect(isRunInProgress("completed")).toBe(false);
    expect(isRunInProgress("superseded")).toBe(false);
    expect(isRunInProgress(undefined)).toBe(false);
  });

  it("polls from detail status for deep links and list/detail races", () => {
    expect(shouldPollExecutionDetail("running", undefined)).toBe(true);
    expect(shouldPollExecutionDetail("running", "exited")).toBe(true);
    expect(shouldPollExecutionDetail("exited", "running")).toBe(false);
    expect(shouldPollExecutionDetail(undefined, "waiting")).toBe(true);
  });
});

describe("toWorkflowExecutionFromSummary", () => {
  // A deep link past the newest-50 list builds the row from this summary alone,
  // so mode, source, event, and entity have to survive the mapping.
  it("keeps start identity from the summary", () => {
    const summary: ExecutionLogsResult["execution"] = {
      id: "exec_past_cap",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 9,
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      scheduledFor: null,
      scheduleDescription: null,
      completedAt: "2026-03-01T10:00:30.000Z",
      duration: "30s",
      runMode: "test",
      startSource: "event",
      startEventName: "app/appointment.created",
      entityValue: "appt_99",
      entity: null,
    };

    const mapped = toWorkflowExecutionFromSummary(summary);

    expect(mapped.runMode).toBe("test");
    expect(mapped.versionKind).toBe("published");
    expect(mapped.versionNumber).toBe(9);
    expect(mapped.startSource).toBe("event");
    expect(mapped.startEventName).toBe("app/appointment.created");
    expect(mapped.entityValue).toBe("appt_99");
    expect(mapped.scheduledFor).toBeNull();
  });

  it("keeps a scheduled run's slot from the summary", () => {
    const summary: ExecutionLogsResult["execution"] = {
      id: "exec_scheduled",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 2,
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T11:30:00.000Z",
      scheduledFor: "2026-03-01T09:00:00.000Z",
      scheduleDescription: null,
      completedAt: "2026-03-01T11:30:01.000Z",
      duration: "1000",
      runMode: "live",
      startSource: "schedule",
      startEventName: null,
      entityValue: "workflow:wf_1",
      entity: null,
    };

    expect(toWorkflowExecutionFromSummary(summary).scheduledFor).toEqual(
      new Date("2026-03-01T09:00:00.000Z")
    );
  });

  // A draft-snapshot run pins to a version with no number. The deep-link path
  // needs the kind as well, so a run reopened past the newest-50 list still
  // reads "Draft" instead of only "Test".
  it("keeps a draft snapshot's kind from the summary", () => {
    const summary: ExecutionLogsResult["execution"] = {
      id: "exec_draft",
      workflowId: "wf_1",
      workflowVersionId: "ver_draft_1",
      versionKind: "draft_snapshot",
      versionNumber: null,
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      scheduledFor: null,
      scheduleDescription: null,
      completedAt: "2026-03-01T10:00:30.000Z",
      duration: "30s",
      runMode: "test",
      startSource: "manual",
      startEventName: null,
      entityValue: null,
      entity: null,
    };

    const mapped = toWorkflowExecutionFromSummary(summary);
    expect(mapped.versionKind).toBe("draft_snapshot");
    expect(mapped.versionNumber).toBeNull();
  });
});

describe("toPinnedRunSummary", () => {
  const basePayload: ExecutionLogsResult = {
    execution: {
      id: "exec_1",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 7,
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      scheduledFor: null,
      scheduleDescription: null,
      completedAt: "2026-03-01T10:00:30.000Z",
      duration: "30s",
      runMode: "live",
      startSource: "event",
      startEventName: "app/appointment.created",
      entityValue: null,
      entity: null,
    },
    logs: [],
    retryLimit: 4,
    waits: [],
    exit: null,
    schedule: null,
  };

  it("carries the pinned run's version and run mode", () => {
    const summary = toPinnedRunSummary(basePayload);

    expect(summary.id).toBe("exec_1");
    expect(summary.versionKind).toBe("published");
    expect(summary.versionNumber).toBe(7);
    expect(summary.runMode).toBe("live");
  });

  it("carries a null version number for a draft snapshot", () => {
    const summary = toPinnedRunSummary({
      ...basePayload,
      execution: {
        ...basePayload.execution,
        versionKind: "draft_snapshot",
        versionNumber: null,
        runMode: "test",
      },
    });

    expect(summary.versionKind).toBe("draft_snapshot");
    expect(summary.versionNumber).toBeNull();
    expect(summary.runMode).toBe("test");
  });
});

describe("toExecutionDetail", () => {
  it("converts the authoritative Exit timestamp", () => {
    const detail = toExecutionDetail({
      execution: {
        id: "exec_exit",
        workflowId: "wf_1",
        workflowVersionId: "ver_1",
        versionKind: "published",
        versionNumber: 7,
        status: "exited",
        input: {},
        output: {},
        error: null,
        startedAt: "2026-03-01T10:00:00.000Z",
        scheduledFor: null,
        scheduleDescription: null,
        completedAt: "2026-03-01T10:00:05.000Z",
        duration: "5000",
        runMode: "live",
        startSource: "event",
        startEventName: "appointment.updated",
        entityValue: null,
        entity: null,
      },
      logs: [],
      retryLimit: 4,
      waits: [],
      exit: {
        reason: "entity_condition_not_met",
        entityType: "patient",
        nodeId: "send-reminder",
        checkedAt: "2026-03-01T10:00:05.000Z",
      },
      schedule: null,
    });

    expect(detail.exit).toEqual({
      reason: "entity_condition_not_met",
      entityType: "patient",
      nodeId: "send-reminder",
      checkedAt: new Date("2026-03-01T10:00:05.000Z"),
    });
  });
});

describe("toExecutionDetail logs of an ended run", () => {
  const basePayload: ExecutionLogsResult = {
    execution: {
      id: "exec_ended",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 7,
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      scheduledFor: null,
      scheduleDescription: null,
      completedAt: "2026-03-01T10:00:05.000Z",
      duration: "5000",
      runMode: "live",
      startSource: "event",
      startEventName: "appointment.updated",
      entityValue: null,
      entity: null,
    },
    logs: [
      {
        id: "log_send",
        executionId: "exec_ended",
        nodeId: "send",
        nodeName: "Send",
        nodeType: "action",
        status: "success",
        input: {},
        output: {},
        startedAt: "2026-03-01T10:00:01.000Z",
        completedAt: "2026-03-01T10:00:02.000Z",
        duration: "1000",
        error: null,
        retries: 0,
      },
      {
        id: "log_wait",
        executionId: "exec_ended",
        nodeId: "wait_1",
        nodeName: "Wait",
        nodeType: "action",
        status: "running",
        input: {},
        output: null,
        startedAt: "2026-03-01T10:00:03.000Z",
        completedAt: null,
        duration: null,
        error: null,
        retries: 0,
      },
    ],
    retryLimit: 4,
    waits: [],
    exit: null,
    schedule: null,
  };

  // Nothing writes to a node's row once its run has ended, so a row still
  // open was cut off, whatever the run ended in.
  it.each(["completed", "failed", "canceled", "exited", "superseded"] as const)(
    "reads an open step as cancelled once the run is %s",
    (status) => {
      const { logs } = toExecutionDetail({
        ...basePayload,
        execution: { ...basePayload.execution, status },
      });

      expect(logs.map((log) => [log.nodeId, log.status])).toEqual([
        ["send", "success"],
        ["wait_1", "cancelled"],
      ]);
    }
  );
});

describe("toExecutionOverlaySource", () => {
  const payload = (
    status: ExecutionLogsResult["execution"]["status"],
    options: {
      logs?: Array<{ nodeId: string; status: "success" | "error" | "running" }>;
      waits?: string[];
    } = {}
  ): ExecutionLogsResult => ({
    execution: {
      id: "exec_1",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 7,
      status,
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      scheduledFor: null,
      scheduleDescription: null,
      completedAt: null,
      duration: null,
      runMode: "live",
      startSource: "event",
      startEventName: "appointment.updated",
      entityValue: null,
      entity: null,
    },
    logs: (options.logs ?? []).map((log, index) => ({
      id: `log_${index}`,
      executionId: "exec_1",
      nodeId: log.nodeId,
      nodeName: log.nodeId,
      nodeType: "action",
      status: log.status,
      input: {},
      output: null,
      startedAt: `2026-03-01T10:00:0${index + 1}.000Z`,
      completedAt: null,
      duration: null,
      error: null,
      retries: 0,
    })),
    retryLimit: 4,
    waits: (options.waits ?? []).map((nodeId) => ({
      id: `wait_${nodeId}`,
      nodeId,
      nodeName: nodeId,
      resumeToken: null,
      subscribedEvents: [],
      waitUntil: null,
    })),
    exit: null,
    schedule: null,
  });

  it("names the last step that failed in a failed run", () => {
    expect(
      toExecutionOverlaySource(
        payload("failed", {
          logs: [
            { nodeId: "first_failure", status: "error" },
            { nodeId: "send", status: "success" },
            { nodeId: "alert", status: "error" },
          ],
        })
      ).stoppedNodeId
    ).toBe("alert");
  });

  it("names the Wait a waiting run is parked on", () => {
    expect(
      toExecutionOverlaySource(
        payload("waiting", {
          logs: [{ nodeId: "hold", status: "running" }],
          waits: ["hold"],
        })
      ).stoppedNodeId
    ).toBe("hold");
  });

  it("names the step a canceled run ended", () => {
    expect(
      toExecutionOverlaySource(
        payload("canceled", {
          logs: [
            { nodeId: "send", status: "success" },
            { nodeId: "hold", status: "running" },
          ],
        })
      ).stoppedNodeId
    ).toBe("hold");
  });

  it.each(["running", "completed"] as const)(
    "names no step for a %s run",
    (status) => {
      expect(
        toExecutionOverlaySource(
          payload(status, { logs: [{ nodeId: "send", status: "success" }] })
        ).stoppedNodeId
      ).toBeNull();
    }
  );
});

describe("applyExecutionStatusToLogs", () => {
  const runningLog = {
    id: "log_wait",
    nodeId: "wait_1",
    nodeName: "Wait",
    nodeType: "action",
    status: "running" as const,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    completedAt: null,
    duration: null,
    error: null,
    retries: 0,
    retryLimit: 4,
  };

  it("leaves in-flight logs alone while the run is still going", () => {
    expect(applyExecutionStatusToLogs([runningLog], "waiting")).toEqual([
      runningLog,
    ]);
  });

  it("reads unfinished steps as cancelled once the run has stopped", () => {
    const [cancelled] = applyExecutionStatusToLogs([runningLog], "canceled");

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe("Run ended before step completion");
  });
});

describe("logsBehindStatusRead", () => {
  const logsRead = {
    executionStatus: "running",
    logs: [
      { nodeId: "send", status: "success" as const },
      { nodeId: "wait", status: "running" as const },
    ],
  };

  it("is caught up when both reads name the same rows and run status", () => {
    expect(
      logsBehindStatusRead(logsRead, {
        status: "running",
        nodeStatuses: [
          { nodeId: "wait", status: "running" },
          { nodeId: "send", status: "success" },
        ],
      })
    ).toBe(false);
  });

  it("is behind once a step's status moves or a new step starts", () => {
    expect(
      logsBehindStatusRead(logsRead, {
        status: "running",
        nodeStatuses: [
          { nodeId: "send", status: "success" },
          { nodeId: "wait", status: "success" },
        ],
      })
    ).toBe(true);
    expect(
      logsBehindStatusRead(logsRead, {
        status: "running",
        nodeStatuses: [
          { nodeId: "send", status: "success" },
          { nodeId: "wait", status: "running" },
          { nodeId: "next", status: "running" },
        ],
      })
    ).toBe(true);
  });

  it("is behind once the run's own status moves", () => {
    expect(
      logsBehindStatusRead(logsRead, {
        status: "canceled",
        nodeStatuses: [
          { nodeId: "send", status: "success" },
          { nodeId: "wait", status: "cancelled" },
        ],
      })
    ).toBe(true);
  });
});
