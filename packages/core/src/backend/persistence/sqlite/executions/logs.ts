import { generateId } from "@wfgraph/shared/utils/id";
import { Effect } from "effect";
import { sql } from "drizzle-orm";
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
        return database
          .run(sql`
            insert into workflow_execution_logs (
              id, execution_id, node_id, node_name, node_type, status,
              input, started_at, timestamp
            ) values (
              ${id}, ${input.executionId}, ${input.nodeId}, ${input.nodeName},
              ${input.nodeType}, 'running', ${encodeJson(input.input)}, ${now}, ${now}
            )
          `)
          .pipe(Effect.as(id));
      }),
    closeNodeLog: (input) =>
      store.write((database) =>
        database.run(sql`
          update workflow_execution_logs set
            status = ${input.status}, output = ${encodeJson(input.output)},
            error = ${input.error ?? null}, completed_at = ${Date.now()},
            duration = ${String(input.durationMs)}
          where id = ${input.logId}
        `)
      ),
    cancelOpenNodeLogs: (executionId) =>
      store.write((database) => {
        const now = Date.now();
        return database.run(sql`
          update workflow_execution_logs
          set status = 'cancelled', completed_at = ${now},
              duration = cast(${now} - started_at as text)
          where execution_id = ${executionId} and status in ('pending', 'running')
        `);
      }),
    readNodeOutputs: (executionId) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(sql`
            select * from workflow_execution_logs
            where execution_id = ${executionId} and status = 'success'
            order by timestamp asc
          `)
          .pipe(
            Effect.map((rows) => {
              const outputs: Record<string, JsonValue> = {};
              for (const row of rows) {
                const log = sqliteExecutionLog(row);
                outputs[log.nodeId] = log.output ?? null;
              }
              return outputs;
            })
          )
      ),
    listLogs: (executionId) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(
            sql`select * from workflow_execution_logs where execution_id = ${executionId} order by timestamp desc`
          )
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionLog)))
      ),
    listNodeStatuses: (executionId) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(
            sql`select node_id, status from workflow_execution_logs where execution_id = ${executionId}`
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => {
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
            )
          )
      ),
  };
}
