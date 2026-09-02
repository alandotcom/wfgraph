import { generateId } from "@wfgraph/shared/utils/id";
import { Effect } from "effect";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { NodeLogsRepoMethods } from "#src/backend/services/executions/repo/node-logs";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionLog } from "#src/backend/persistence/sqlite/executions/rows";
import { workflowExecutionLogs } from "#src/backend/persistence/sqlite/schema";

export function makeSqliteNodeLogsMethods(
  store: SqliteDatabase
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) =>
      store.write((database) => {
        const id = generateId();
        const now = Date.now();
        return database
          .insert(workflowExecutionLogs)
          .values({
            id,
            executionId: input.executionId,
            nodeId: input.nodeId,
            nodeName: input.nodeName,
            nodeType: input.nodeType,
            status: "running",
            input: encodeJson(input.input),
            startedAt: now,
            timestamp: now,
          })
          .pipe(Effect.as(id));
      }),
    closeNodeLog: (input) =>
      store.write((database) =>
        database
          .update(workflowExecutionLogs)
          .set({
            status: input.status,
            output: encodeJson(input.output),
            error: input.error ?? null,
            completedAt: Date.now(),
            duration: String(input.durationMs),
          })
          .where(eq(workflowExecutionLogs.id, input.logId))
      ),
    cancelOpenNodeLogs: (executionId) =>
      store.write((database) => {
        const now = Date.now();
        return database
          .update(workflowExecutionLogs)
          .set({
            status: "cancelled",
            completedAt: now,
            duration: sql<string>`cast(${now} - ${workflowExecutionLogs.startedAt} as text)`,
          })
          .where(
            and(
              eq(workflowExecutionLogs.executionId, executionId),
              inArray(workflowExecutionLogs.status, ["pending", "running"])
            )
          );
      }),
    readNodeOutputs: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionLogs)
          .where(
            and(
              eq(workflowExecutionLogs.executionId, executionId),
              eq(workflowExecutionLogs.status, "success")
            )
          )
          .orderBy(asc(workflowExecutionLogs.timestamp))
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
          .select()
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .orderBy(desc(workflowExecutionLogs.timestamp))
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionLog)))
      ),
    listNodeStatuses: (executionId) =>
      store.read((database) =>
        database
          .select({
            nodeId: workflowExecutionLogs.nodeId,
            status: workflowExecutionLogs.status,
          })
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => {
                const { nodeId, status } = row;
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
