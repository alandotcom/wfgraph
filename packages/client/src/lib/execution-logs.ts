import {
  IN_FLIGHT_EXECUTION_STATUSES,
  nodeStatusInRun,
  type EntityEligibilityReason,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { ExecutionLogEntry } from "@wfgraph/shared/graph/types";
import { decodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";
import type {
  ExecutionLogsResult,
  WorkflowExecutionsGlobalResult,
} from "#src/lib/rpc-client";
import {
  type ListActivity,
  withExecutorReading,
} from "#src/lib/run-executor-activity";

/**
 * The shapes a workflow run takes on the client, and the pure functions that
 * reshape what the server sends into them.
 *
 * These live apart from workflow-run-shared.tsx, which is a component module.
 * The query layer and the graph store both need this logic, and neither should
 * have to pull JSX in to get it.
 */

export type ExecutionLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  startedAt: Date;
  completedAt: Date | null;
  duration: string | null;
  input?: unknown;
  output?: unknown;
  error: string | null;
  /**
   * How many times the database executor retried the node's steps before this
   * execution finished. Zero while it is unfinished.
   */
  retries: number;
  /**
   * How many retries the executor gives each step of the node, which
   * `retries` counts against, from the run's logs answer.
   */
  retryLimit: number;
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
  runMode: "live" | "test";
  /**
   * The graph this run pinned to. A `draft_snapshot` is the canvas graph a draft
   * run froze for itself. The UI labels a snapshot "Draft" and a published
   * version by the number in `versionNumber`, then renders the run as
   * "<graph> · <recipients>", for example "Draft · Test" or "v7 · Live".
   */
  versionKind: WorkflowVersionKind;
  /** The pinned version's number, rendered as "v7". Null for a draft snapshot. */
  versionNumber: number | null;
  startEventName: string | null;
  entityValue: string | null;
  startedAt: Date;
  /**
   * The slot a scheduled run fired for, which is earlier than `startedAt`
   * when the run started late. Null for a run no schedule started.
   */
  scheduledFor: Date | null;
  /**
   * The schedule that started a scheduled run, in words, which the Runs view
   * shows under the run's title. Null for a run no schedule started.
   */
  scheduleDescription: string | null;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
  error: string | null;
  /**
   * What the database executor is doing about the run, as the runs list
   * carries it, and null for a run with nothing to say or read elsewhere.
   */
  activity: ListActivity | null;
};

export type ExecutionEvent = {
  id: string;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: Date;
};

export type ExecutionExit = {
  reason: EntityEligibilityReason;
  entityType: string;
  nodeId: string;
  checkedAt: Date;
};

/**
 * One node this run is parked at, with what would unpark it.
 *
 * A run reaches this state when a Wait node is holding it, and the token is what
 * the panel's Resume affordance posts: an operator's way out when the Event a run
 * is waiting for is never going to arrive.
 */
export type ExecutionWait = {
  id: string;
  nodeId: string;
  nodeName: string;
  resumeToken: string | null;
  subscribedEvents: string[];
  waitUntil: Date | null;
};

/**
 * One Refused Start, which is an arrival that opened no run. It carries no
 * execution id for the same reason: there is no run to point at.
 */
export type RefusedStart = {
  id: string;
  message: string;
  createdAt: Date;
};

/** One Cancellation Failure, which is a Cancel Event that reached no run. */
export type CancelNotDelivered = RefusedStart;

type RawRefusedStart = Omit<RefusedStart, "createdAt"> & { createdAt: string };

/** A run status that can still change, and so is still worth polling. */
export function isRunInProgress(status: string | undefined): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((inFlight) => inFlight === status);
}

/**
 * Keeps detail polling until the detail response itself observes a verdict.
 * Its status outranks the list because a deep link may be outside that list,
 * and the list can observe the terminal row before detail fetches it.
 */
export function shouldPollExecutionDetail(
  detailStatus: string | undefined,
  listedStatus: string | undefined
): boolean {
  return isRunInProgress(detailStatus ?? listedStatus);
}

/**
 * A scheduled run's slot, read through the shared timestamp codec. The
 * contract already refused a string that is not an ISO timestamp, so null
 * here means no schedule started the run.
 */
function toScheduledFor(value: string | null): Date | null {
  return value === null ? null : decodeIsoTimestamp(value);
}

/**
 * Timestamps arrive as ISO strings and are compared and formatted as Dates.
 *
 * These conversions are module-level so they can be passed to a query as
 * `select` by reference. TanStack memoises a select by its identity, and these
 * feed every node on the canvas: an inline closure would rebuild the whole map
 * on every render and re-render the canvas with it.
 */
export function toWorkflowExecutions(payload: {
  readonly items: readonly RawExecution[];
  readonly observedAt: string;
  readonly overdueAfterMs: number;
  readonly runRetentionMs: number | null;
  readonly supersededCount: number;
  readonly refusedStarts: readonly RawRefusedStart[];
  readonly cancelNotDelivered: readonly RawRefusedStart[];
}): {
  executions: WorkflowExecution[];
  runRetentionMs: number | null;
  supersededCount: number;
  refusedStarts: RefusedStart[];
  cancelNotDelivered: CancelNotDelivered[];
} {
  return {
    runRetentionMs: payload.runRetentionMs,
    supersededCount: payload.supersededCount,
    refusedStarts: payload.refusedStarts.map((refusal) => ({
      ...refusal,
      createdAt: new Date(refusal.createdAt),
    })),
    cancelNotDelivered: payload.cancelNotDelivered.map((failure) => ({
      ...failure,
      createdAt: new Date(failure.createdAt),
    })),
    executions: payload.items.map((execution) => ({
      ...execution,
      activity: withExecutorReading(execution.activity, payload),
      startedAt: new Date(execution.startedAt),
      scheduledFor: toScheduledFor(execution.scheduledFor),
      waitingAt: execution.waitingAt ? new Date(execution.waitingAt) : null,
      cancelledAt: execution.cancelledAt
        ? new Date(execution.cancelledAt)
        : null,
      completedAt: execution.completedAt
        ? new Date(execution.completedAt)
        : null,
    })),
  };
}

/**
 * Everything the run detail view reads, off the one payload that carries it.
 *
 * The logs and the waits arrive together, so they are selected together: two
 * observers on one query key would each hold their own `refetchInterval`, and the
 * pair would drift apart into two polls of the same endpoint.
 *
 * The execution summary rides along for deep-links that open a run no longer in
 * the polled list: the panel needs a row shape before it can show detail, and
 * the list cannot supply one past its newest-50 cap. The pinned graph itself is
 * not here -- it is immutable once published, so it rides `getVersionGraph`
 * instead, fetched once per `workflowVersionId` and cached forever rather than
 * retransmitted on every poll of this payload.
 *
 * The executor's schedule stays in its wire form, ISO strings and all, because
 * the copy that reads it measures time against its `observedAt`.
 */
export function toExecutionDetail(payload: ExecutionLogsResult): {
  logs: ExecutionLog[];
  waits: ExecutionWait[];
  execution: WorkflowExecution & { workflowVersionId: string };
  exit: ExecutionExit | null;
  schedule: ExecutionLogsResult["schedule"];
} {
  return {
    logs: toExecutionLogs(payload),
    waits: payload.waits.map((wait) => ({
      ...wait,
      waitUntil: wait.waitUntil ? new Date(wait.waitUntil) : null,
    })),
    execution: {
      ...toWorkflowExecutionFromSummary(payload.execution),
      workflowVersionId: payload.execution.workflowVersionId,
    },
    exit: payload.exit
      ? { ...payload.exit, checkedAt: new Date(payload.exit.checkedAt) }
      : null,
    schedule: payload.schedule,
  };
}

/**
 * The logs endpoint's thinner execution summary, turned into the row shape the
 * Runs view already uses. Start identity rides on the summary so a deep link
 * past the newest-50 list still paints mode, source, event, and entity.
 */
export function toWorkflowExecutionFromSummary(
  summary: ExecutionLogsResult["execution"]
): WorkflowExecution {
  return {
    id: summary.id,
    workflowId: summary.workflowId,
    status: summary.status,
    startSource: summary.startSource,
    runMode: summary.runMode,
    versionKind: summary.versionKind,
    versionNumber: summary.versionNumber,
    startEventName: summary.startEventName,
    entityValue: summary.entityValue,
    startedAt: new Date(summary.startedAt),
    scheduledFor: toScheduledFor(summary.scheduledFor),
    scheduleDescription: summary.scheduleDescription,
    waitingAt: null,
    cancelledAt: null,
    completedAt: summary.completedAt ? new Date(summary.completedAt) : null,
    duration: summary.duration,
    error: summary.error,
    // The logs read carries the run's executor state as `schedule` instead.
    activity: null,
  };
}

export function toExecutionLogsByNodeId(
  payload: ExecutionLogsResult
): Record<string, ExecutionLogEntry> {
  return createExecutionLogsMap(toExecutionLogs(payload));
}

/**
 * The fields the overlay sync needs from the logs payload: which workflow the
 * run belongs to, and which published version pins its graph. Logs and waits
 * stay on the Runs view's own observer of the same query key.
 */
export function toExecutionOverlaySource(payload: ExecutionLogsResult): {
  workflowId: string;
  workflowVersionId: string;
} {
  return {
    workflowId: payload.execution.workflowId,
    workflowVersionId: payload.execution.workflowVersionId,
  };
}

/**
 * The little the status strip says about the run pinned to the canvas: which run
 * it is, when it started, and which graph and recipients it ran with.
 *
 * A third narrow select on the logs key, beside the panel's detail select and
 * the overlay sync's. None of these fields move once the run exists, so this
 * observer carries no `refetchInterval` and reads whatever the other two
 * fetched.
 *
 * `startedAt` crosses the wire as a plain string, so it is parsed defensively
 * here rather than at the strip: the other two selects hand their `Date` to a
 * relative-time helper that says "just now" for an unparseable one, while the
 * strip prints the parts and would render "NaN undefined, NaN:NaN".
 */
export function toPinnedRunSummary(payload: ExecutionLogsResult): {
  id: string;
  startedAt: Date | null;
  versionKind: WorkflowVersionKind;
  versionNumber: number | null;
  runMode: "live" | "test";
} {
  const startedAt = new Date(payload.execution.startedAt);

  return {
    id: payload.execution.id,
    startedAt: Number.isNaN(startedAt.getTime()) ? null : startedAt,
    versionKind: payload.execution.versionKind,
    versionNumber: payload.execution.versionNumber,
    runMode: payload.execution.runMode,
  };
}

export function toExecutionEvents(
  payload: RawExecutionEvents
): ExecutionEvent[] {
  return payload.events.map((event) => ({
    ...event,
    createdAt: new Date(event.createdAt),
  }));
}

type RawExecution = Omit<
  WorkflowExecution,
  | "startedAt"
  | "scheduledFor"
  | "waitingAt"
  | "cancelledAt"
  | "completedAt"
  | "activity"
> & {
  startedAt: string;
  scheduledFor: string | null;
  waitingAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  activity: WorkflowExecutionsGlobalResult["items"][number]["activity"];
};

function toExecutionLogs(payload: ExecutionLogsResult): ExecutionLog[] {
  return applyExecutionStatusToLogs(
    payload.logs.map((log) => ({
      id: log.id,
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      startedAt: new Date(log.startedAt),
      completedAt: log.completedAt ? new Date(log.completedAt) : null,
      duration: log.duration,
      input: log.input,
      output: log.output,
      error: log.error,
      retries: log.retries,
      retryLimit: payload.retryLimit,
    })),
    payload.execution.status
  );
}

type RawExecutionEvents = {
  events: Array<Omit<ExecutionEvent, "createdAt"> & { createdAt: string }>;
};

function getLogStartedAtMs(log: Pick<ExecutionLog, "startedAt">): number {
  return new Date(log.startedAt).getTime();
}

/**
 * The latest log entry per node, which is what a node on the canvas wants to
 * show. A node can appear more than once in a run when a branch loops back, and
 * the newest attempt is the one whose status the node badge reflects.
 */
export function createExecutionLogsMap(
  logs: ExecutionLog[]
): Record<string, ExecutionLogEntry> {
  const logsMap: Record<string, ExecutionLogEntry> = {};
  for (const log of logs) {
    const previous = logsMap[log.nodeId];
    if (
      previous?.startedAt !== undefined &&
      getLogStartedAtMs(log) < new Date(previous.startedAt).getTime()
    ) {
      continue;
    }

    logsMap[log.nodeId] = {
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      input: log.input,
      output: log.output,
      startedAt: log.startedAt,
      completedAt: log.completedAt,
    };
  }
  return logsMap;
}

/**
 * A run's steps as `nodeStatusInRun` reads them, which is what the server's
 * status read answers too. A step its run's end cut off carries a reason when
 * it recorded none.
 */
export function applyExecutionStatusToLogs(
  logEntries: ExecutionLog[],
  executionStatus: string
): ExecutionLog[] {
  return mapOrSame(logEntries, (log) => {
    const status = nodeStatusInRun(log.status, executionStatus);
    return status === log.status
      ? log
      : {
          ...log,
          status,
          error: log.error || "Run ended before step completion",
        };
  });
}
