import { readJsonValue, type JsonValue } from "@wfgraph/shared/types/json";
import type {
  WorkflowExecution,
  WorkflowExecutionEvent,
  WorkflowExecutionListRow,
  WorkflowExecutionLog,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";

type SqliteExecutionRow = typeof workflowExecutions.$inferSelect;
type SqliteExecutionLogRow = typeof workflowExecutionLogs.$inferSelect;
type SqliteExecutionEventRow = typeof workflowExecutionEvents.$inferSelect;
type SqliteWaitStateRow = typeof workflowWaitStates.$inferSelect;
export type SqliteExecutionListRow = Pick<
  SqliteExecutionRow,
  | "id"
  | "workflowId"
  | "status"
  | "startSource"
  | "runMode"
  | "startEventName"
  | "entityValue"
  | "workflowRunId"
  | "error"
  | "startedAt"
  | "waitingAt"
  | "cancelledAt"
  | "completedAt"
  | "duration"
> & {
  versionKind: string;
  versionNumber: number | null;
};
function optionalJsonValue(
  value: string | null,
  key: string
): JsonValue | null {
  if (value === null) return null;
  const json = readJsonValue(JSON.parse(value));
  if (json === null && value !== "null")
    throw new Error(`Invalid SQLite ${key}`);
  return json;
}

function optionalJsonObject(value: string | null, key: string) {
  if (value === null) return null;
  const json = readJsonValue(JSON.parse(value));
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return json;
}

export function sqliteExecutionStatus(
  value: string
): WorkflowExecution["status"] {
  if (
    value !== "pending" &&
    value !== "running" &&
    value !== "waiting" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "canceled" &&
    value !== "superseded"
  ) {
    throw new Error("Invalid SQLite execution status");
  }
  return value;
}

function startSource(value: string | null): WorkflowExecution["startSource"] {
  if (
    value !== null &&
    value !== "event" &&
    value !== "manual" &&
    value !== "schedule"
  ) {
    throw new Error("Invalid SQLite execution start source");
  }
  return value;
}

function runMode(value: string): WorkflowExecution["runMode"] {
  if (value !== "live" && value !== "test") {
    throw new Error("Invalid SQLite execution run mode");
  }
  return value;
}

function versionKind(value: string): WorkflowExecutionListRow["versionKind"] {
  if (value !== "published" && value !== "draft_snapshot") {
    throw new Error("Invalid SQLite version_kind");
  }
  return value;
}

/**
 * The execution's own columns that the run lists read. The version kind and
 * number come from a join, so the readers that ask for them add those two. The
 * whole-row reader has no join and so has no values for them.
 */
function executionListColumns(
  row: Omit<SqliteExecutionListRow, "versionKind" | "versionNumber">
): Omit<WorkflowExecutionListRow, "versionKind" | "versionNumber"> {
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: sqliteExecutionStatus(row.status),
    startSource: startSource(row.startSource),
    runMode: runMode(row.runMode),
    startEventName: row.startEventName,
    entityValue: row.entityValue,
    workflowRunId: row.workflowRunId,
    error: row.error,
    startedAt: new Date(row.startedAt),
    waitingAt: row.waitingAt === null ? null : new Date(row.waitingAt),
    cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    duration: row.duration,
  };
}

/** One run-list row, from a query that joined the version it pinned. */
export function sqliteExecutionListRow(
  row: SqliteExecutionListRow
): WorkflowExecutionListRow {
  return {
    ...executionListColumns(row),
    versionKind: versionKind(row.versionKind),
    versionNumber: row.versionNumber,
  };
}

export function sqliteExecution(row: SqliteExecutionRow): WorkflowExecution {
  return {
    ...executionListColumns(row),
    workflowVersionId: row.workflowVersionId,
    deliveryId: row.deliveryId,
    enqueuedAt: row.enqueuedAt === null ? null : new Date(row.enqueuedAt),
    input: optionalJsonObject(row.input, "input"),
    output: optionalJsonValue(row.output, "output"),
    cancelRequestedAt:
      row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt),
    cancelEventName: row.cancelEventName,
    cancelPayload: optionalJsonObject(row.cancelPayload, "cancel_payload"),
  };
}

function logStatus(value: string): WorkflowExecutionLog["status"] {
  if (
    value !== "pending" &&
    value !== "running" &&
    value !== "success" &&
    value !== "error" &&
    value !== "cancelled"
  ) {
    throw new Error("Invalid SQLite node log status");
  }
  return value;
}

export function sqliteExecutionLog(
  row: SqliteExecutionLogRow
): WorkflowExecutionLog {
  return {
    id: row.id,
    executionId: row.executionId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    nodeType: row.nodeType,
    status: logStatus(row.status),
    input: optionalJsonValue(row.input, "input"),
    output: optionalJsonValue(row.output, "output"),
    error: row.error,
    startedAt: new Date(row.startedAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    duration: row.duration,
    timestamp: new Date(row.timestamp),
  };
}

function waitStatus(value: string): WorkflowWaitState["status"] {
  if (
    value !== "waiting" &&
    value !== "resuming" &&
    value !== "resumed" &&
    value !== "timed_out" &&
    value !== "cancelled"
  ) {
    throw new Error("Invalid SQLite wait status");
  }
  return value;
}

function isString(value: JsonValue): value is string {
  return typeof value === "string";
}

function stringArray(encoded: string, key: string): string[] {
  const value = readJsonValue(JSON.parse(encoded));
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return value;
}

export function sqliteWaitState(row: SqliteWaitStateRow): WorkflowWaitState {
  const waitType = row.waitType;
  if (waitType !== "delay" && waitType !== "event") {
    throw new Error("Invalid SQLite wait type");
  }
  return {
    id: row.id,
    executionId: row.executionId,
    workflowId: row.workflowId,
    runId: row.runId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    waitType,
    status: waitStatus(row.status),
    resumeToken: row.resumeToken,
    waitUntil: row.waitUntil === null ? null : new Date(row.waitUntil),
    subscribedEvents: stringArray(row.subscribedEvents, "subscribed_events"),
    metadata: optionalJsonObject(row.metadata, "metadata"),
    createdAt: new Date(row.createdAt),
    resumedAt: row.resumedAt === null ? null : new Date(row.resumedAt),
    cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
  };
}

export function sqliteExecutionEvent(
  row: SqliteExecutionEventRow
): WorkflowExecutionEvent {
  return {
    id: row.id,
    workflowId: row.workflowId,
    executionId: row.executionId,
    eventType: row.eventType,
    message: row.message,
    metadata: optionalJsonObject(row.metadata, "metadata"),
    createdAt: new Date(row.createdAt),
  };
}
