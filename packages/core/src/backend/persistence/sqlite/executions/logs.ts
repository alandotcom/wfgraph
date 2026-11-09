import { Effect } from "effect";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type {
  CloseNodeLogInput,
  NodeLogsRepoMethods,
  OpenNodeLogInput,
} from "#src/backend/services/executions/repo/node-logs";
import type { RunFence } from "#src/backend/services/executions/repo/contracts";
import { nodeLogId } from "#src/backend/services/executions/repo/node-logs";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  sqliteExecutionLog,
  sqliteNodeLogStatus,
} from "#src/backend/persistence/sqlite/executions/rows";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
} from "#src/backend/persistence/sqlite/schema";
import {
  nodeLogCloseGuard,
  nodeLogCloseRetries,
} from "#src/backend/services/executions/repo/node-log-close";

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
 * The update behind `closeNodeLog`, the statement the PostgreSQL write runs:
 * it applies only to a row `nodeLogCloseGuard` admits, and given a fence, only
 * to a row of the fenced Execution.
 */
export function closeNodeLogWrite(input: CloseNodeLogInput, fence?: RunFence) {
  return (database: SqliteExecutor) =>
    database
      .update(workflowExecutionLogs)
      .set({
        status: input.status,
        output: encodeJson(input.output),
        error: input.error ?? null,
        completedAt: Date.now(),
        duration: String(input.durationMs),
        retries: nodeLogCloseRetries({
          logs: workflowExecutionLogs,
          schedule: workflowExecutionSchedule,
          steps: workflowExecutionSteps,
        }),
      })
      .where(
        and(
          eq(workflowExecutionLogs.id, input.logId),
          fence === undefined
            ? undefined
            : eq(workflowExecutionLogs.executionId, fence.executionId),
          nodeLogCloseGuard({
            logs: workflowExecutionLogs,
            close: input.status,
          })
        )
      );
}

export function makeSqliteNodeLogsMethods(
  store: SqliteDatabase
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) => store.write(openNodeLogWrite(input)),
    closeNodeLog: (input) => store.write(closeNodeLogWrite(input)),
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
              rows.map((row) => ({
                nodeId: row.nodeId,
                status: sqliteNodeLogStatus(row.status),
              }))
            )
          )
      ),
    listNodeLogStates: (executionId) =>
      store.read((database) =>
        database
          .select({
            id: workflowExecutionLogs.id,
            status: workflowExecutionLogs.status,
            startedAt: workflowExecutionLogs.startedAt,
          })
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                id: row.id,
                status: sqliteNodeLogStatus(row.status),
                startedAt: new Date(row.startedAt),
              }))
            )
          )
      ),
  };
}
