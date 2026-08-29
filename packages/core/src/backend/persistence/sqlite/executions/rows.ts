import { readJsonValue, type JsonValue } from "@wfgraph/shared/types/json";
import type {
  WorkflowExecution,
  WorkflowExecutionEvent,
  WorkflowExecutionListRow,
  WorkflowExecutionLog,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  optionalDate,
  optionalJsonObject,
  optionalJsonValue,
  optionalNumber,
  optionalString,
  requiredDate,
  requiredString,
  requiredVersionKind,
} from "#src/backend/persistence/sqlite/database";

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

/**
 * The execution's own columns the run lists read. The version kind and number
 * ride beside them from a join, so they are added by the readers that ask for
 * them rather than here, where the whole-row reader would have nothing to put in
 * them.
 */
function executionListColumns(
  row: Record<string, unknown>
): Omit<WorkflowExecutionListRow, "versionKind" | "versionNumber"> {
  return {
    id: requiredString(row, "id"),
    workflowId: requiredString(row, "workflow_id"),
    status: sqliteExecutionStatus(requiredString(row, "status")),
    startSource: startSource(optionalString(row, "start_source")),
    runMode: runMode(requiredString(row, "run_mode")),
    startEventName: optionalString(row, "start_event_name"),
    entityValue: optionalString(row, "entity_value"),
    workflowRunId: optionalString(row, "workflow_run_id"),
    error: optionalString(row, "error"),
    startedAt: requiredDate(row, "started_at"),
    waitingAt: optionalDate(row, "waiting_at"),
    cancelledAt: optionalDate(row, "cancelled_at"),
    completedAt: optionalDate(row, "completed_at"),
    duration: optionalString(row, "duration"),
  };
}

/** One run-list row, from a query that joined the version it pinned. */
export function sqliteExecutionListRow(
  row: Record<string, unknown>
): WorkflowExecutionListRow {
  return {
    ...executionListColumns(row),
    versionKind: requiredVersionKind(row, "version_kind"),
    versionNumber: optionalNumber(row, "version_number"),
  };
}

export function sqliteExecution(
  row: Record<string, unknown>
): WorkflowExecution {
  return {
    ...executionListColumns(row),
    workflowVersionId: requiredString(row, "workflow_version_id"),
    deliveryId: optionalString(row, "delivery_id"),
    enqueuedAt: optionalDate(row, "enqueued_at"),
    input: optionalJsonObject(row, "input"),
    output: optionalJsonValue(row, "output"),
    cancelRequestedAt: optionalDate(row, "cancel_requested_at"),
    cancelEventName: optionalString(row, "cancel_event_name"),
    cancelPayload: optionalJsonObject(row, "cancel_payload"),
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
  row: Record<string, unknown>
): WorkflowExecutionLog {
  return {
    id: requiredString(row, "id"),
    executionId: requiredString(row, "execution_id"),
    nodeId: requiredString(row, "node_id"),
    nodeName: requiredString(row, "node_name"),
    nodeType: requiredString(row, "node_type"),
    status: logStatus(requiredString(row, "status")),
    input: optionalJsonValue(row, "input"),
    output: optionalJsonValue(row, "output"),
    error: optionalString(row, "error"),
    startedAt: requiredDate(row, "started_at"),
    completedAt: optionalDate(row, "completed_at"),
    duration: optionalString(row, "duration"),
    timestamp: requiredDate(row, "timestamp"),
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

function stringArray(row: Record<string, unknown>, key: string): string[] {
  const encoded = requiredString(row, key);
  const value = readJsonValue(JSON.parse(encoded));
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return value;
}

export function sqliteWaitState(
  row: Record<string, unknown>
): WorkflowWaitState {
  const waitType = requiredString(row, "wait_type");
  if (waitType !== "delay" && waitType !== "event") {
    throw new Error("Invalid SQLite wait type");
  }
  return {
    id: requiredString(row, "id"),
    executionId: requiredString(row, "execution_id"),
    workflowId: requiredString(row, "workflow_id"),
    runId: requiredString(row, "run_id"),
    nodeId: requiredString(row, "node_id"),
    nodeName: requiredString(row, "node_name"),
    waitType,
    status: waitStatus(requiredString(row, "status")),
    resumeToken: optionalString(row, "resume_token"),
    waitUntil: optionalDate(row, "wait_until"),
    subscribedEvents: stringArray(row, "subscribed_events"),
    metadata: optionalJsonObject(row, "metadata"),
    createdAt: requiredDate(row, "created_at"),
    resumedAt: optionalDate(row, "resumed_at"),
    cancelledAt: optionalDate(row, "cancelled_at"),
  };
}

export function sqliteExecutionEvent(
  row: Record<string, unknown>
): WorkflowExecutionEvent {
  const eventType = requiredString(row, "event_type");
  return {
    id: requiredString(row, "id"),
    workflowId: requiredString(row, "workflow_id"),
    executionId: optionalString(row, "execution_id"),
    eventType,
    message: requiredString(row, "message"),
    metadata: optionalJsonObject(row, "metadata"),
    createdAt: requiredDate(row, "created_at"),
  };
}
