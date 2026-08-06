import { describe, expect, it } from "vitest";
import {
  isRunInProgress,
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
  startEventName: "app/appointment.created",
  entityValue: "appt_1",
  workflowRunId: null,
  input: null,
  output: null,
  error: null,
  startedAt: "2026-03-01T10:00:00.000Z",
  waitingAt: null,
  cancelledAt: null,
  completedAt: "2026-03-01T10:00:05.000Z",
  duration: "5000",
};

describe("toWorkflowExecutions", () => {
  // Timestamps arrive as ISO strings and are compared and formatted as Dates, so
  // this is where the wire shape becomes the shape every row reads.
  it("keeps the three members the panel reads", () => {
    const result = toWorkflowExecutions({
      items: [rawExecution],
      supersededCount: 3,
      refusedStarts: [
        {
          id: "evt_1",
          message: "Refused a start",
          createdAt: "2026-03-01T09:59:00.000Z",
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
  });

  // A run that never waited or was cancelled carries nulls, and a Date built from
  // one would be an Invalid Date the row would then format.
  it("leaves an absent timestamp absent", () => {
    const result = toWorkflowExecutions({
      items: [{ ...rawExecution, completedAt: null }],
      supersededCount: 0,
      refusedStarts: [],
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
});

describe("toWorkflowExecutionFromSummary", () => {
  // A deep link past the newest-50 list builds the row from this summary alone,
  // so mode, source, event, and entity have to survive the mapping.
  it("keeps start identity from the summary", () => {
    const summary: ExecutionLogsResult["execution"] = {
      id: "exec_past_cap",
      workflowId: "wf_1",
      status: "completed",
      input: {},
      output: {},
      error: null,
      startedAt: "2026-03-01T10:00:00.000Z",
      completedAt: "2026-03-01T10:00:30.000Z",
      duration: "30s",
      runMode: "test",
      startSource: "event",
      startEventName: "app/appointment.created",
      entityValue: "appt_99",
    };

    const mapped = toWorkflowExecutionFromSummary(summary);

    expect(mapped.runMode).toBe("test");
    expect(mapped.startSource).toBe("event");
    expect(mapped.startEventName).toBe("app/appointment.created");
    expect(mapped.entityValue).toBe("appt_99");
  });
});
