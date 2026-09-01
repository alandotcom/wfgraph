import type { SQLInputValue } from "node:sqlite";
import { generateId } from "@wfgraph/shared/utils/id";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { RunsRepoMethods } from "#src/backend/services/executions/repo/runs";
import type {
  ExecutionSummary,
  GlobalExecutionRow,
  NewExecution,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  optionalDate,
  optionalJsonObject,
  optionalNumber,
  optionalString,
  placeholders,
  requiredBoolean,
  requiredString,
  requiredVersionKind,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";
import {
  sqliteExecution,
  sqliteExecutionListRow,
  sqliteExecutionStatus,
} from "#src/backend/persistence/sqlite/executions/rows";

const WORKFLOW_EXECUTIONS_LIMIT = 50;

/**
 * The columns both run-list queries select, plus the two they join for. JSONB
 * payloads and the routing columns the lists never paint stay off this list, so
 * a poll does not pull blobs the panel would discard. `version_kind` and
 * `version_number` come from the version the run pinned, and they label a run's
 * graph.
 */
const EXECUTION_LIST_SELECT = `e.id, e.workflow_id, e.status, e.start_source,
         e.run_mode, e.start_event_name, e.entity_value, e.workflow_run_id,
         e.error, e.started_at, e.waiting_at, e.cancelled_at, e.completed_at,
         e.duration, v.kind AS version_kind, v.version AS version_number`;

/** Every run pins exactly one version, so both list reads join it. */
const PINNED_VERSION_JOIN = `JOIN workflow_versions v ON v.id = e.workflow_version_id`;

export function insertExecution(
  database: import("node:sqlite").DatabaseSync,
  input: NewExecution,
  status: WorkflowExecution["status"],
  terminal?: { output?: JsonValue; error?: string }
): WorkflowExecution {
  const id = generateId();
  const now = Date.now();
  const isTerminal =
    status === "completed" || status === "failed" || status === "canceled";
  database
    .prepare(
      `INSERT INTO workflow_executions (
         id, workflow_id, workflow_version_id, status, start_source,
         delivery_id, run_mode, start_event_name, entity_value, input,
         output, error, started_at, cancelled_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.workflowId,
      input.workflowVersionId,
      status,
      input.startSource,
      input.deliveryId ?? null,
      input.runMode,
      input.startEventName ?? null,
      input.entityValue ?? null,
      encodeJson(input.input),
      encodeJson(terminal?.output),
      terminal?.error ?? null,
      now,
      status === "canceled" ? now : null,
      isTerminal ? now : null
    );
  const row = database
    .prepare("SELECT * FROM workflow_executions WHERE id = ?")
    .get(id);
  if (!row) throw new Error("SQLite did not return the inserted execution");
  return sqliteExecution(row);
}

function executionSummary(row: Record<string, unknown>): ExecutionSummary {
  const execution = sqliteExecution(row);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowVersionId: execution.workflowVersionId,
    versionKind: requiredVersionKind(row, "version_kind"),
    versionNumber: optionalNumber(row, "version_number"),
    status: execution.status,
    startSource: execution.startSource,
    runMode: execution.runMode,
    startEventName: execution.startEventName,
    entityValue: execution.entityValue,
    input: execution.input,
    output: execution.output,
    error: execution.error,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    duration: execution.duration,
  };
}

function globalExecution(row: Record<string, unknown>): GlobalExecutionRow {
  return {
    ...sqliteExecutionListRow(row),
    workflowName: requiredString(row, "workflow_name"),
    workflowIsPaused: requiredBoolean(row, "workflow_is_paused"),
  };
}

export function makeSqliteRunsMethods(store: SqliteDatabase): RunsRepoMethods {
  return {
    listByWorkflow: ({ workflowId, includeSuperseded }) =>
      store.read((database) =>
        database
          .prepare(
            `SELECT ${EXECUTION_LIST_SELECT}
             FROM workflow_executions e ${PINNED_VERSION_JOIN}
             WHERE e.workflow_id = ? ${includeSuperseded ? "" : "AND e.status <> 'superseded'"}
             ORDER BY e.started_at DESC, e.id DESC LIMIT ${WORKFLOW_EXECUTIONS_LIMIT}`
          )
          .all(workflowId)
          .map(sqliteExecutionListRow)
      ),
    countSuperseded: (workflowId) =>
      store.read((database) => {
        const row = database
          .prepare(
            "SELECT count(*) AS total FROM workflow_executions WHERE workflow_id = ? AND status = 'superseded'"
          )
          .get(workflowId);
        const total = row?.total;
        if (typeof total !== "number") throw new Error("Invalid SQLite count");
        return total;
      }),
    listPage: (query) =>
      store.read((database) => {
        const filters: string[] = [];
        const values: SQLInputValue[] = [];
        if (query.workflowIds?.length) {
          filters.push(
            `e.workflow_id IN (${placeholders(query.workflowIds.length)})`
          );
          values.push(...query.workflowIds);
        }
        if (query.statuses?.length) {
          filters.push(`e.status IN (${placeholders(query.statuses.length)})`);
          values.push(...query.statuses);
        }
        if (query.cursor) {
          filters.push("(e.started_at < ? OR (e.started_at = ? AND e.id < ?))");
          const startedAt = query.cursor.startedAt.getTime();
          values.push(startedAt, startedAt, query.cursor.id);
        }
        values.push(query.limit);
        return database
          .prepare(
            `SELECT ${EXECUTION_LIST_SELECT}, w.name AS workflow_name,
                    w.is_paused AS workflow_is_paused
             FROM workflow_executions e
             JOIN workflows w ON w.id = e.workflow_id
             ${PINNED_VERSION_JOIN}
             ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
             ORDER BY e.started_at DESC, e.id DESC LIMIT ?`
          )
          .all(...values)
          .map(globalExecution);
      }),
    findSummaryById: (executionId) =>
      store.read((database) => {
        const row = database
          .prepare(
            `SELECT e.*, v.kind AS version_kind, v.version AS version_number
             FROM workflow_executions e ${PINNED_VERSION_JOIN}
             WHERE e.id = ?`
          )
          .get(executionId);
        return row ? executionSummary(row) : null;
      }),
    findStatusById: (executionId) =>
      store.read((database) => {
        const row = database
          .prepare("SELECT id, status FROM workflow_executions WHERE id = ?")
          .get(executionId);
        if (!row) return null;
        return {
          id: requiredString(row, "id"),
          status: sqliteExecutionStatus(requiredString(row, "status")),
        };
      }),
    existsById: (executionId) =>
      store.read(
        (database) =>
          database
            .prepare("SELECT 1 FROM workflow_executions WHERE id = ?")
            .get(executionId) !== undefined
      ),
    findWorkflowIdById: (executionId) =>
      store.read((database) => {
        const row = database
          .prepare("SELECT workflow_id FROM workflow_executions WHERE id = ?")
          .get(executionId);
        return row ? requiredString(row, "workflow_id") : null;
      }),
    insertTerminal: (input) =>
      store.write((database) =>
        insertExecution(database, input, input.status, input)
      ),
    markEnqueued: ({ executionId, runId }) =>
      store.write((database) => {
        database
          .prepare(
            "UPDATE workflow_executions SET workflow_run_id = ?, enqueued_at = ? WHERE id = ?"
          )
          .run(runId, Date.now(), executionId);
      }),
    markEnqueueFailed: ({ executionId, error }) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE workflow_executions SET status = 'failed', error = ?,
                    completed_at = ?, waiting_at = NULL
             WHERE id = ? AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
            )
            .run(error, Date.now(), executionId).changes > 0
      ),
    markRunning: (executionId) =>
      store.write(
        (database) =>
          database
            .prepare(
              "UPDATE workflow_executions SET status = 'running', waiting_at = NULL WHERE id = ? AND status = 'waiting'"
            )
            .run(executionId).changes > 0
      ),
    endInFlight: (input) =>
      store.write((database) => {
        const now = Date.now();
        return (
          database
            .prepare(
              `UPDATE workflow_executions SET status = ?, waiting_at = NULL,
                      cancelled_at = ?, completed_at = ?, error = ?
               WHERE id = ? AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
            )
            .run(
              input.status,
              input.status === "canceled" ? now : null,
              now,
              input.error ?? null,
              input.executionId
            ).changes > 0
        );
      }),
    requestCancelForEntity: (input) =>
      store.write((database) => {
        const rows = database
          .prepare(
            `SELECT id FROM workflow_executions
             WHERE workflow_id = ? AND entity_value = ? AND run_mode = ?
                AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES}) AND cancel_requested_at IS NULL`
          )
          .all(input.workflowId, input.entityValue, input.runMode);
        database
          .prepare(
            `UPDATE workflow_executions SET cancel_requested_at = ?,
                    cancel_event_name = ?, cancel_payload = ?
             WHERE workflow_id = ? AND entity_value = ? AND run_mode = ?
                AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES}) AND cancel_requested_at IS NULL`
          )
          .run(
            Date.now(),
            input.eventName,
            encodeJson(input.payload),
            input.workflowId,
            input.entityValue,
            input.runMode
          );
        return rows.map((row) => requiredString(row, "id"));
      }),
    findPendingCancel: (executionId) =>
      store.read((database) => {
        const row = database
          .prepare(
            "SELECT cancel_requested_at, cancel_event_name, cancel_payload FROM workflow_executions WHERE id = ?"
          )
          .get(executionId);
        if (!row || optionalDate(row, "cancel_requested_at") === null) {
          return null;
        }
        return {
          eventName: optionalString(row, "cancel_event_name"),
          payload: optionalJsonObject(row, "cancel_payload"),
        };
      }),
    finishRun: (input) =>
      store.write((database) => {
        const row = database
          .prepare("SELECT started_at FROM workflow_executions WHERE id = ?")
          .get(input.executionId);
        if (!row || typeof row.started_at !== "number") return false;
        const now = Date.now();
        return (
          database
            .prepare(
              `UPDATE workflow_executions SET status = ?, output = ?, error = ?,
                      waiting_at = NULL, completed_at = ?, duration = ?
                WHERE id = ? AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
            )
            .run(
              input.status,
              encodeJson(input.output),
              input.error ?? null,
              now,
              String(now - row.started_at),
              input.executionId
            ).changes > 0
        );
      }),
  };
}
