import { generateId } from "@wfgraph/shared/utils/id";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { NodeLogsRepoMethods } from "#src/backend/services/executions/repo/node-logs";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  requiredString,
} from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionLog } from "#src/backend/persistence/sqlite/executions/rows";

export function makeSqliteNodeLogsMethods(
  store: SqliteDatabase
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) =>
      store.write((database) => {
        const id = generateId();
        const now = Date.now();
        database
          .prepare(
            `INSERT INTO workflow_execution_logs (
               id, execution_id, node_id, node_name, node_type, status,
               input, started_at, timestamp
             ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`
          )
          .run(
            id,
            input.executionId,
            input.nodeId,
            input.nodeName,
            input.nodeType,
            encodeJson(input.input),
            now,
            now
          );
        return id;
      }),
    closeNodeLog: (input) =>
      store.write((database) => {
        database
          .prepare(
            `UPDATE workflow_execution_logs SET status = ?, output = ?,
                    error = ?, completed_at = ?, duration = ? WHERE id = ?`
          )
          .run(
            input.status,
            encodeJson(input.output),
            input.error ?? null,
            Date.now(),
            String(input.durationMs),
            input.logId
          );
      }),
    cancelOpenNodeLogs: (executionId) =>
      store.write((database) => {
        const now = Date.now();
        database
          .prepare(
            `UPDATE workflow_execution_logs
             SET status = 'cancelled', completed_at = ?,
                 duration = CAST(? - started_at AS TEXT)
             WHERE execution_id = ? AND status IN ('pending', 'running')`
          )
          .run(now, now, executionId);
      }),
    readNodeOutputs: (executionId) =>
      store.read((database) => {
        const outputs: Record<string, JsonValue> = {};
        for (const row of database
          .prepare(
            `SELECT * FROM workflow_execution_logs
             WHERE execution_id = ? AND status = 'success'
             ORDER BY timestamp ASC`
          )
          .all(executionId)) {
          const log = sqliteExecutionLog(row);
          outputs[log.nodeId] = log.output ?? null;
        }
        return outputs;
      }),
    listLogs: (executionId) =>
      store.read((database) =>
        database
          .prepare(
            "SELECT * FROM workflow_execution_logs WHERE execution_id = ? ORDER BY timestamp DESC"
          )
          .all(executionId)
          .map(sqliteExecutionLog)
      ),
    listNodeStatuses: (executionId) =>
      store.read((database) =>
        database
          .prepare(
            "SELECT node_id, status FROM workflow_execution_logs WHERE execution_id = ?"
          )
          .all(executionId)
          .map((row) => {
            const nodeId = requiredString(row, "node_id");
            const status = requiredString(row, "status");
            if (
              status !== "pending" &&
              status !== "running" &&
              status !== "success" &&
              status !== "error" &&
              status !== "cancelled"
            ) {
              throw new Error("Invalid SQLite node log status");
            }
            return { nodeId, status };
          })
      ),
  };
}
