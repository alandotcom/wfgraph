import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { generateId } from "@wfgraph/shared/utils/id";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type {
  WaitResumeClaim,
  WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  placeholders,
} from "#src/backend/persistence/sqlite/database";
import { sqliteWaitState } from "#src/backend/persistence/sqlite/executions/rows";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;
const IN_FLIGHT = "'pending', 'running', 'waiting'";

function claimWait(
  database: DatabaseSync,
  column: "id" | "resume_token",
  value: string
): WaitResumeClaim | null {
  const claimedAt = new Date();
  const claimedAtMs = claimedAt.getTime();
  const staleBefore = claimedAtMs - WAIT_RESUME_CLAIM_LEASE_MS;
  const candidate = database
    .prepare(
      `SELECT ws.id FROM workflow_wait_states ws
       JOIN workflow_executions e ON e.id = ws.execution_id
       WHERE ws.${column} = ?
         AND (ws.status = 'waiting' OR
              (ws.status = 'resuming' AND ws.resumed_at <= ?))
          AND e.status IN (${IN_FLIGHT})`
    )
    .get(value, staleBefore);
  if (!candidate || typeof candidate.id !== "string") return null;

  const changed = database
    .prepare(
      `UPDATE workflow_wait_states
       SET status = 'resuming', resumed_at = ?
       WHERE id = ? AND (status = 'waiting' OR
                         (status = 'resuming' AND resumed_at <= ?))`
    )
    .run(claimedAtMs, candidate.id, staleBefore).changes;
  if (changed === 0) return null;
  const row = database
    .prepare("SELECT * FROM workflow_wait_states WHERE id = ?")
    .get(candidate.id);
  if (!row) throw new Error("SQLite did not return the claimed wait");
  return { waitState: sqliteWaitState(row), claimedAt };
}

export function makeSqliteWaitsMethods(
  store: SqliteDatabase
): WaitsRepoMethods {
  return {
    startWait: (input) =>
      store.write((database) => {
        const now = Date.now();
        const parked = database
          .prepare(
            `UPDATE workflow_executions SET status = 'waiting', waiting_at = ?
             WHERE id = ? AND status IN (${IN_FLIGHT})`
          )
          .run(now, input.executionId).changes;
        if (parked === 0) return undefined;
        const id = generateId();
        database
          .prepare(
            `INSERT INTO workflow_wait_states (
               id, execution_id, workflow_id, run_id, node_id, node_name,
               wait_type, status, resume_token, wait_until,
               subscribed_events, metadata, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            input.executionId,
            input.workflowId,
            input.runId,
            input.nodeId,
            input.nodeName,
            input.waitType,
            input.resumeToken ?? null,
            input.waitUntil?.getTime() ?? null,
            JSON.stringify(input.subscribedEvents ?? []),
            encodeJson(toJsonObject(input.metadata)),
            now
          );
        return { waitStateId: id };
      }),
    markWaitStatus: (input) =>
      store.write((database) => {
        const allowed =
          input.status === "resumed"
            ? "status = 'waiting'"
            : "status IN ('waiting', 'resuming')";
        const now = Date.now();
        const resumedAt = input.status === "cancelled" ? null : now;
        const cancelledAt = input.status === "cancelled" ? now : null;
        return (
          database
            .prepare(
              `UPDATE workflow_wait_states SET status = ?, resumed_at = ?, cancelled_at = ?
               WHERE id = ? AND ${allowed}`
            )
            .run(input.status, resumedAt, cancelledAt, input.waitStateId)
            .changes > 0
        );
      }),
    cancelWaits: (waitStateIds) =>
      store.write((database) => {
        if (waitStateIds.length === 0) return [];
        const rows = database
          .prepare(
            `SELECT id FROM workflow_wait_states
             WHERE id IN (${placeholders(waitStateIds.length)})
               AND status IN ('waiting', 'resuming')`
          )
          .all(...waitStateIds);
        database
          .prepare(
            `UPDATE workflow_wait_states SET status = 'cancelled', cancelled_at = ?
             WHERE id IN (${placeholders(waitStateIds.length)})
               AND status IN ('waiting', 'resuming')`
          )
          .run(Date.now(), ...waitStateIds);
        return rows.map((row) => {
          if (typeof row.id !== "string")
            throw new Error("Invalid SQLite wait id");
          return row.id;
        });
      }),
    cancelWaitsForExecution: (executionId) =>
      store.write((database) => {
        database
          .prepare(
            `UPDATE workflow_wait_states SET status = 'cancelled', cancelled_at = ?
             WHERE execution_id = ? AND status IN ('waiting', 'resuming')`
          )
          .run(Date.now(), executionId);
      }),
    listWaitsForEvent: (input) =>
      store.read((database) => {
        const filters = [
          "ws.workflow_id = ?",
          "ws.status = 'waiting'",
          `e.status IN (${IN_FLIGHT})`,
          "EXISTS (SELECT 1 FROM json_each(ws.subscribed_events) j WHERE j.value = ?)",
        ];
        const values: SQLInputValue[] = [input.workflowId, input.eventName];
        if (input.afterId) {
          filters.push("ws.id > ?");
          values.push(input.afterId);
        }
        if (input.excludingExecutionIds?.length) {
          filters.push(
            `ws.execution_id NOT IN (${placeholders(input.excludingExecutionIds.length)})`
          );
          values.push(...input.excludingExecutionIds);
        }
        values.push(input.limit);
        return database
          .prepare(
            `SELECT ws.* FROM workflow_wait_states ws
             JOIN workflow_executions e ON e.id = ws.execution_id
             WHERE ${filters.join(" AND ")}
             ORDER BY ws.id ASC LIMIT ?`
          )
          .all(...values)
          .map(sqliteWaitState);
      }),
    claimWaitingStateByToken: (resumeToken) =>
      store.write((database) =>
        claimWait(database, "resume_token", resumeToken)
      ),
    claimWaitingStateById: (waitStateId) =>
      store.write((database) => claimWait(database, "id", waitStateId)),
    settleWaitingStateClaim: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE workflow_wait_states SET status = 'resumed', resumed_at = ?
               WHERE id = ? AND status = 'resuming' AND resumed_at = ?`
            )
            .run(Date.now(), input.waitStateId, input.claimedAt.getTime())
            .changes > 0
      ),
    releaseWaitingStateClaim: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE workflow_wait_states SET status = 'waiting', resumed_at = NULL
               WHERE id = ? AND status = 'resuming' AND resumed_at = ?`
            )
            .run(input.waitStateId, input.claimedAt.getTime()).changes > 0
      ),
    listWaitingStates: (executionId) =>
      store.read((database) =>
        database
          .prepare(
            "SELECT * FROM workflow_wait_states WHERE execution_id = ? AND status = 'waiting'"
          )
          .all(executionId)
          .map(sqliteWaitState)
      ),
    listWaitingStatesForExecutions: (executionIds) =>
      store.read((database) => {
        const grouped = new Map<string, WorkflowWaitState[]>();
        if (executionIds.length === 0) return grouped;
        const rows = database
          .prepare(
            `SELECT * FROM workflow_wait_states
             WHERE execution_id IN (${placeholders(executionIds.length)})
               AND status = 'waiting'`
          )
          .all(...executionIds)
          .map(sqliteWaitState);
        for (const row of rows) {
          const existing = grouped.get(row.executionId);
          if (existing) existing.push(row);
          else grouped.set(row.executionId, [row]);
        }
        return grouped;
      }),
  };
}
