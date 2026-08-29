import {
  IN_FLIGHT_EXECUTION_STATUSES,
  WORKFLOW_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { ExecutionLogEntry } from "@wfgraph/shared/graph/types";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";
import type { ExecutionLogsResult } from "#src/lib/rpc-client";

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
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
  runMode: "live" | "test";
  /**
   * Which kind of graph this run pinned to: `published`, or the `draft_snapshot`
   * a test-mode draft run froze for itself. Only a `draft_snapshot` run is ever
   * labelled "Draft" -- a published-graph test run stays "Test" alone.
   */
  versionKind: WorkflowVersionKind;
  startEventName: string | null;
  entityValue: string | null;
  workflowRunId: string | null;
  startedAt: Date;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
  error: string | null;
};

export type ExecutionEvent = {
  id: string;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: Date;
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

type RawRefusedStart = Omit<RefusedStart, "createdAt"> & { createdAt: string };

/** A run status that can still change, and so is still worth polling. */
export function isRunInProgress(status: string | undefined): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((inFlight) => inFlight === status);
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
  readonly supersededCount: number;
  readonly refusedStarts: readonly RawRefusedStart[];
}): {
  executions: WorkflowExecution[];
  supersededCount: number;
  refusedStarts: RefusedStart[];
} {
  return {
    supersededCount: payload.supersededCount,
    refusedStarts: payload.refusedStarts.map((refusal) => ({
      ...refusal,
      createdAt: new Date(refusal.createdAt),
    })),
    executions: payload.items.map((execution) => ({
      ...execution,
      startedAt: new Date(execution.startedAt),
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
 */
export function toExecutionDetail(payload: ExecutionLogsResult): {
  logs: ExecutionLog[];
  waits: ExecutionWait[];
  execution: WorkflowExecution & { workflowVersionId: string };
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
  };
}

/**
 * The logs endpoint's thinner execution summary, turned into the row shape the
 * Runs panel already uses. Start identity rides on the summary so a deep link
 * past the newest-50 list still paints mode, source, event, and entity.
 */
export function toWorkflowExecutionFromSummary(
  summary: ExecutionLogsResult["execution"]
): WorkflowExecution {
  return {
    id: summary.id,
    workflowId: summary.workflowId,
    status: toExecutionStatus(summary.status),
    startSource: summary.startSource,
    runMode: summary.runMode,
    versionKind: summary.versionKind,
    startEventName: summary.startEventName,
    entityValue: summary.entityValue,
    workflowRunId: null,
    startedAt: new Date(summary.startedAt),
    waitingAt: null,
    cancelledAt: null,
    completedAt: summary.completedAt ? new Date(summary.completedAt) : null,
    duration: summary.duration,
    error: summary.error,
  };
}

function toExecutionStatus(status: string): WorkflowExecutionStatus {
  for (const known of WORKFLOW_EXECUTION_STATUSES) {
    if (known === status) {
      return known;
    }
  }
  return "failed";
}

export function toExecutionLogsByNodeId(
  payload: ExecutionLogsResult
): Record<string, ExecutionLogEntry> {
  return createExecutionLogsMap(toExecutionLogs(payload));
}

/**
 * The fields the overlay sync needs from the logs payload: which workflow the
 * run belongs to, and which published version pins its graph. Logs and waits
 * stay on the Runs panel's own observer of the same query key.
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
 * it is, and when it started.
 *
 * A third narrow select on the logs key, beside the panel's detail select and
 * the overlay sync's. Neither field moves once the run exists, so this observer
 * carries no `refetchInterval` and reads whatever the other two fetched.
 *
 * `startedAt` crosses the wire as a plain string, so it is parsed defensively
 * here rather than at the strip: the other two selects hand their `Date` to a
 * relative-time helper that says "just now" for an unparseable one, while the
 * strip prints the parts and would render "NaN undefined, NaN:NaN".
 */
export function toPinnedRunSummary(payload: ExecutionLogsResult): {
  id: string;
  startedAt: Date | null;
} {
  const startedAt = new Date(payload.execution.startedAt);

  return {
    id: payload.execution.id,
    startedAt: Number.isNaN(startedAt.getTime()) ? null : startedAt,
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
  "startedAt" | "waitingAt" | "cancelledAt" | "completedAt"
> & {
  startedAt: string;
  waitingAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
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
 * A run that stopped leaves its unfinished steps recorded as pending or running,
 * because nothing ever came back to close them out. They read as cancelled,
 * which is a step's own vocabulary rather than the run's.
 */
export function applyExecutionStatusToLogs(
  logEntries: ExecutionLog[],
  executionStatus: string
): ExecutionLog[] {
  if (executionStatus !== "canceled" && executionStatus !== "superseded") {
    return logEntries;
  }

  return logEntries.map((log) => {
    if (log.status === "pending" || log.status === "running") {
      return {
        ...log,
        status: "cancelled" as const,
        error: log.error || "Run cancelled before step completion",
      };
    }
    return log;
  });
}
