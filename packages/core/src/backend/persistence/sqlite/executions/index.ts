import type { DatabaseSync } from "node:sqlite";
import { partition } from "es-toolkit";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  EntityStartOutcome,
  NewExecution,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import {
  ExecutionRepo,
  UNSENT_RUN_GRACE_MS,
  UNSENT_RUN_RECLAIM_REASON,
} from "#src/backend/services/executions/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  placeholders,
  requiredNumber,
  requiredString,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";
import {
  makeSqliteRunsMethods,
  insertExecution,
} from "#src/backend/persistence/sqlite/executions/runs";
import { makeSqliteNodeLogsMethods } from "#src/backend/persistence/sqlite/executions/logs";
import { makeSqliteWaitsMethods } from "#src/backend/persistence/sqlite/executions/waits";
import { makeSqliteAuditMethods } from "#src/backend/persistence/sqlite/executions/audit";
import { sqliteExecution } from "#src/backend/persistence/sqlite/executions/rows";

function findByDelivery(
  database: DatabaseSync,
  execution: NewExecution
): WorkflowExecution | null {
  if (!execution.deliveryId) return null;
  const row = database
    .prepare(
      "SELECT * FROM workflow_executions WHERE workflow_id = ? AND delivery_id = ?"
    )
    .get(execution.workflowId, execution.deliveryId);
  return row ? sqliteExecution(row) : null;
}

function endInFlightExecutions(
  database: DatabaseSync,
  ids: string[],
  update: { status: "failed" | "superseded"; error: string }
): string[] {
  if (ids.length === 0) return [];
  const eligible = database
    .prepare(
      `SELECT id FROM workflow_executions
       WHERE id IN (${placeholders(ids.length)}) AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
    )
    .all(...ids)
    .map((row) => requiredString(row, "id"));
  if (eligible.length === 0) return [];
  database
    .prepare(
      `UPDATE workflow_executions SET status = ?, waiting_at = NULL,
              completed_at = ?, error = ?
       WHERE id IN (${placeholders(eligible.length)}) AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
    )
    .run(update.status, Date.now(), update.error, ...eligible);
  return eligible;
}

function startForEntity(
  database: DatabaseSync,
  execution: NewExecution,
  concurrency: Concurrency,
  supersededReason: string
): EntityStartOutcome {
  const own = findByDelivery(database, execution);
  if (own) {
    return {
      status: "started",
      execution: own,
      supersededExecutionIds: [],
      reclaimedExecutionIds: [],
    };
  }
  if (concurrency === "unlimited" || !execution.entityValue) {
    return {
      status: "started",
      execution: insertExecution(database, execution, "running"),
      supersededExecutionIds: [],
      reclaimedExecutionIds: [],
    };
  }

  const inFlight = database
    .prepare(
      `SELECT id, enqueued_at, started_at FROM workflow_executions
       WHERE workflow_id = ? AND entity_value = ? AND run_mode = ?
          AND status IN (${SQLITE_IN_FLIGHT_EXECUTION_STATUSES})`
    )
    .all(execution.workflowId, execution.entityValue, execution.runMode);

  let reclaimedExecutionIds: string[] = [];
  if (inFlight.length > 0 && concurrency === "first-wins") {
    const staleBefore = Date.now() - UNSENT_RUN_GRACE_MS;
    const candidates = inFlight.map((row) => ({
      id: requiredString(row, "id"),
      enqueuedAt: row.enqueued_at,
      startedAt: requiredNumber(row, "started_at"),
    }));
    const [stuck, live] = partition(
      candidates,
      (candidate) =>
        candidate.enqueuedAt === null && candidate.startedAt < staleBefore
    );
    if (live.length > 0) {
      return {
        status: "refused",
        inFlightExecutionIds: live.map((candidate) => candidate.id),
      };
    }
    reclaimedExecutionIds = endInFlightExecutions(
      database,
      stuck.map((candidate) => candidate.id),
      { status: "failed", error: UNSENT_RUN_RECLAIM_REASON }
    );
  }

  let supersededExecutionIds: string[] = [];
  if (inFlight.length > 0 && concurrency !== "first-wins") {
    supersededExecutionIds = endInFlightExecutions(
      database,
      inFlight.map((row) => requiredString(row, "id")),
      { status: "superseded", error: supersededReason }
    );
    if (supersededExecutionIds.length > 0) {
      database
        .prepare(
          `UPDATE workflow_wait_states SET status = 'cancelled', cancelled_at = ?
           WHERE execution_id IN (${placeholders(supersededExecutionIds.length)})
             AND status = 'waiting'`
        )
        .run(Date.now(), ...supersededExecutionIds);
    }
  }

  return {
    status: "started",
    execution: insertExecution(database, execution, "running"),
    supersededExecutionIds,
    reclaimedExecutionIds,
  };
}

export function makeSqliteExecutionRepo(
  store: SqliteDatabase
): ExecutionRepo["Service"] {
  return {
    ...makeSqliteRunsMethods(store),
    ...makeSqliteNodeLogsMethods(store),
    ...makeSqliteWaitsMethods(store),
    ...makeSqliteAuditMethods(store),
    startForEntity: ({ execution, concurrency, supersededReason }) =>
      store.write((database) =>
        startForEntity(database, execution, concurrency, supersededReason)
      ),
    deleteAllForWorkflow: (workflowId) =>
      store.write((database) => {
        database
          .prepare(
            "DELETE FROM workflow_execution_events WHERE workflow_id = ?"
          )
          .run(workflowId);
        return Number(
          database
            .prepare("DELETE FROM workflow_executions WHERE workflow_id = ?")
            .run(workflowId).changes
        );
      }),
  };
}
