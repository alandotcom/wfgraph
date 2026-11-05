import { Effect } from "effect";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type {
  CloseNodeLogInput,
  NodeLogsRepoMethods,
  OpenNodeLogInput,
} from "#src/backend/services/executions/repo/node-logs";
import type { OwnerFence } from "#src/backend/services/executions/repo/contracts";
import { nodeLogId } from "#src/backend/services/executions/repo/fencing";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionLog } from "#src/backend/persistence/sqlite/executions/rows";
import { workflowExecutionLogs } from "#src/backend/persistence/sqlite/schema";

/** The insert behind `openNodeLog`; see its comment for the derived id. */
export function openNodeLogWrite(input: OpenNodeLogInput) {
  return (database: SqliteExecutor) => {
    const id = nodeLogId(input.executionId, input.nodeId);
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
      .onConflictDoNothing({ target: workflowExecutionLogs.id })
      .pipe(Effect.as(id));
  };
}

/**
 * The update behind `closeNodeLog`. Given a fence, it closes only a row of the
 * fenced Execution that is `running` or `error`, as the PostgreSQL write does.
 */
export function closeNodeLogWrite(
  input: CloseNodeLogInput,
  fence?: OwnerFence
) {
  return (database: SqliteExecutor) =>
    database
      .update(workflowExecutionLogs)
      .set({
        status: input.status,
        output: encodeJson(input.output),
        error: input.error ?? null,
        completedAt: Date.now(),
        duration: String(input.durationMs),
      })
      .where(
        and(
          eq(workflowExecutionLogs.id, input.logId),
          fence === undefined
            ? undefined
            : and(
                eq(workflowExecutionLogs.executionId, fence.executionId),
                inArray(workflowExecutionLogs.status, ["running", "error"])
              )
        )
      );
}

/** The update behind `cancelOpenNodeLogs`. */
export function cancelOpenNodeLogsWrite(executionId: string) {
  return (database: SqliteExecutor) => {
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
  };
}

export function makeSqliteNodeLogsMethods(
  store: SqliteDatabase
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) => store.write(openNodeLogWrite(input)),
    closeNodeLog: (input) => store.write(closeNodeLogWrite(input)),
    cancelOpenNodeLogs: (executionId) =>
      store.write(cancelOpenNodeLogsWrite(executionId)),
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
    listLoggedNodeIdsForExecutions: (executionIds) =>
      store.read((database) => {
        if (executionIds.length === 0) {
          return Effect.succeed(new Map<string, Set<string>>());
        }
        return database
          .selectDistinct({
            executionId: workflowExecutionLogs.executionId,
            nodeId: workflowExecutionLogs.nodeId,
          })
          .from(workflowExecutionLogs)
          .where(inArray(workflowExecutionLogs.executionId, executionIds))
          .pipe(
            Effect.map((rows) => {
              const byExecution = new Map<string, Set<string>>();
              for (const row of rows) {
                const existing = byExecution.get(row.executionId);
                if (existing) existing.add(row.nodeId);
                else byExecution.set(row.executionId, new Set([row.nodeId]));
              }
              return byExecution;
            })
          );
      }),
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
