import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@rova/shared/workflow/execution-contracts";
import type { ExecutionLogEntry } from "@rova/shared/workflow/types";

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
  triggerEventType: string | null;
  correlationKey: string | null;
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

export function toExecutionLogs(payload: RawExecutionLogs): ExecutionLog[] {
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
 * Everything the run detail view reads, off the one payload that carries it.
 *
 * The logs and the waits arrive together, so they are selected together: two
 * observers on one query key would each hold their own `refetchInterval`, and the
 * pair would drift apart into two polls of the same endpoint.
 */
export function toExecutionDetail(payload: RawExecutionLogs): {
  logs: ExecutionLog[];
  waits: ExecutionWait[];
} {
  return {
    logs: toExecutionLogs(payload),
    waits: payload.waits.map((wait) => ({
      ...wait,
      waitUntil: wait.waitUntil ? new Date(wait.waitUntil) : null,
    })),
  };
}

export function toExecutionLogsByNodeId(
  payload: RawExecutionLogs
): Record<string, ExecutionLogEntry> {
  return createExecutionLogsMap(toExecutionLogs(payload));
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

type RawExecutionLogs = {
  execution: { status: string };
  logs: Array<
    Omit<ExecutionLog, "startedAt" | "completedAt"> & {
      startedAt: string;
      completedAt: string | null;
    }
  >;
  waits: Array<Omit<ExecutionWait, "waitUntil"> & { waitUntil: string | null }>;
};

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
