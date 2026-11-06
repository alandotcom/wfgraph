import { Schema } from "effect";
import { isEntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  jsonObjectSchema,
  readJsonValue,
  type JsonValue,
} from "@wfgraph/shared/types/json";
import { readAs } from "@wfgraph/shared/types/schema";
import type {
  ExecutionSchedule,
  ParkState,
  ParkWake,
  WorkflowExecution,
  WorkflowExecutionEvent,
  WorkflowExecutionListRow,
  WorkflowExecutionLog,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutionSchedule,
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
export function optionalJsonValue(
  value: string | null,
  key: string
): JsonValue | null {
  if (value === null) return null;
  const json = readJsonValue(JSON.parse(value));
  if (json === null && value !== "null")
    throw new Error(`Invalid SQLite ${key}`);
  return json;
}

export function optionalJsonObject(value: string | null, key: string) {
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
    value !== "exited" &&
    value !== "superseded"
  ) {
    throw new Error("Invalid SQLite execution status");
  }
  return value;
}

function terminationKind(
  value: string | null
): WorkflowExecution["terminationKind"] {
  if (value !== null && value !== "cancel" && value !== "exit") {
    throw new Error("Invalid SQLite execution termination kind");
  }
  return value;
}

function terminationReason(
  value: string | null
): WorkflowExecution["terminationReason"] {
  if (value !== null && !isEntityEligibilityReason(value)) {
    throw new Error("Invalid SQLite execution termination reason");
  }
  return value;
}

function startSource(value: string): WorkflowExecution["startSource"] {
  if (value !== "event" && value !== "manual" && value !== "schedule") {
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

export function sqliteVersionKind(
  value: string
): WorkflowExecutionListRow["versionKind"] {
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
    versionKind: sqliteVersionKind(row.versionKind),
    versionNumber: row.versionNumber,
  };
}

export function sqliteExecution(row: SqliteExecutionRow): WorkflowExecution {
  return {
    ...executionListColumns(row),
    workflowVersionId: row.workflowVersionId,
    deliveryId: row.deliveryId,
    input: optionalJsonObject(row.input, "input"),
    output: optionalJsonValue(row.output, "output"),
    entityType: row.entityType,
    entityId: row.entityId,
    terminationKind: terminationKind(row.terminationKind),
    terminationRequestedAt:
      row.terminationRequestedAt === null
        ? null
        : new Date(row.terminationRequestedAt),
    terminationReason: terminationReason(row.terminationReason),
    terminationNodeId: row.terminationNodeId,
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

type SqliteScheduleRow = typeof workflowExecutionSchedule.$inferSelect;

/** A schedule row decoded from SQLite's text and epoch-millisecond columns. */
export function sqliteExecutionSchedule(
  row: SqliteScheduleRow
): ExecutionSchedule {
  const { kind, state } = row;
  if (kind !== "run" && kind !== "delivery") {
    throw new Error("Invalid SQLite schedule kind");
  }
  if (state !== "queued" && state !== "leased" && state !== "waiting") {
    throw new Error("Invalid SQLite schedule state");
  }
  return {
    id: row.id,
    kind,
    executionId: row.executionId,
    state,
    wakeAt: new Date(row.wakeAt),
    attempt: row.attempt,
    runningStepId: row.runningStepId,
    leaseExpiresAt:
      row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt),
    ownerToken: row.ownerToken,
    workerId: row.workerId,
    lastError: row.lastError,
  };
}

const parkWakeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["timeout", "migrate", "cancel", "exit"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("resume"),
    eventName: Schema.NullOr(Schema.String),
    payload: jsonObjectSchema,
    deliveryId: Schema.NullOr(Schema.String),
  }),
]);
const readParkWake = readAs(parkWakeSchema);

/** A wait row's `wake` column as the wake it holds, or null while parked. */
export function sqliteParkWake(encoded: string | null): ParkWake | null {
  if (encoded === null) return null;
  const wake: ParkWake | undefined = readParkWake(JSON.parse(encoded));
  if (wake === undefined) throw new Error("Invalid SQLite wait wake");
  return wake;
}

/** A park as `findPark` answers it, from the columns that query selects. */
export function sqliteParkState(
  row: Pick<
    SqliteWaitStateRow,
    "executionId" | "status" | "parkStepId" | "wake"
  > & {
    waitStateId: string;
  }
): ParkState {
  return {
    waitStateId: row.waitStateId,
    executionId: row.executionId,
    status: waitStatus(row.status),
    parkStepId: row.parkStepId,
    wake: sqliteParkWake(row.wake),
  };
}

export function sqliteWaitState(
  row: Omit<SqliteWaitStateRow, "parkStepId" | "wake">
): WorkflowWaitState {
  const waitType = row.waitType;
  if (waitType !== "delay" && waitType !== "event") {
    throw new Error("Invalid SQLite wait type");
  }
  return {
    id: row.id,
    executionId: row.executionId,
    workflowId: row.workflowId,
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
