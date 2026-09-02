import { Effect } from "effect";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { readJsonObject, type JsonValue } from "@wfgraph/shared/types/json";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { RunsRepoMethods } from "#src/backend/services/executions/repo/runs";
import type {
  ExecutionSummary,
  GlobalExecutionRow,
  NewExecution,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutions,
  workflows,
  workflowVersions,
} from "#src/backend/persistence/sqlite/schema";
import {
  sqliteExecution,
  sqliteExecutionListRow,
  sqliteExecutionStatus,
  type SqliteExecutionListRow,
} from "#src/backend/persistence/sqlite/executions/rows";

const WORKFLOW_EXECUTIONS_LIMIT = 50;

/** The payload-free fields painted by the two polling run lists. */
const executionListSelection = {
  id: workflowExecutions.id,
  workflowId: workflowExecutions.workflowId,
  status: workflowExecutions.status,
  startSource: workflowExecutions.startSource,
  runMode: workflowExecutions.runMode,
  startEventName: workflowExecutions.startEventName,
  entityValue: workflowExecutions.entityValue,
  workflowRunId: workflowExecutions.workflowRunId,
  error: workflowExecutions.error,
  startedAt: workflowExecutions.startedAt,
  waitingAt: workflowExecutions.waitingAt,
  cancelledAt: workflowExecutions.cancelledAt,
  completedAt: workflowExecutions.completedAt,
  duration: workflowExecutions.duration,
  versionKind: workflowVersions.kind,
  versionNumber: workflowVersions.version,
};

function optionalJsonObject(value: string | null) {
  if (value === null) return null;
  const json = readJsonObject(JSON.parse(value));
  if (json === null) throw new Error("Invalid SQLite cancel_payload");
  return json;
}

export function insertExecution(
  database: SqliteExecutor,
  input: NewExecution,
  status: WorkflowExecution["status"],
  terminal?: { output?: JsonValue | undefined; error?: string | undefined }
) {
  return Effect.gen(function* () {
    const id = generateId();
    const now = Date.now();
    const isTerminal =
      status === "completed" || status === "failed" || status === "canceled";
    const [row] = yield* database
      .insert(workflowExecutions)
      .values({
        id,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        status,
        startSource: input.startSource,
        deliveryId: input.deliveryId ?? null,
        runMode: input.runMode,
        startEventName: input.startEventName ?? null,
        entityValue: input.entityValue ?? null,
        input: encodeJson(input.input),
        output: encodeJson(terminal?.output),
        error: terminal?.error ?? null,
        startedAt: now,
        cancelledAt: status === "canceled" ? now : null,
        completedAt: isTerminal ? now : null,
      })
      .returning();
    if (!row) throw new Error("SQLite did not return the inserted execution");
    return sqliteExecution(row);
  });
}

function executionSummary(
  row: typeof workflowExecutions.$inferSelect & {
    versionKind: string;
    versionNumber: number | null;
  }
): ExecutionSummary {
  const execution = sqliteExecution(row);
  const version = sqliteExecutionListRow(row);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowVersionId: execution.workflowVersionId,
    versionKind: version.versionKind,
    versionNumber: version.versionNumber,
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

function globalExecution(
  row: SqliteExecutionListRow & {
    workflowName: string;
    workflowIsPaused: number;
  }
): GlobalExecutionRow {
  if (row.workflowIsPaused !== 0 && row.workflowIsPaused !== 1) {
    throw new Error("Invalid SQLite workflow_is_paused");
  }
  return {
    ...sqliteExecutionListRow(row),
    workflowName: row.workflowName,
    workflowIsPaused: row.workflowIsPaused === 1,
  };
}

export function makeSqliteRunsMethods(store: SqliteDatabase): RunsRepoMethods {
  return {
    listByWorkflow: ({ workflowId, includeSuperseded }) =>
      store.read((database) =>
        database
          .select(executionListSelection)
          .from(workflowExecutions)
          .innerJoin(
            workflowVersions,
            eq(workflowVersions.id, workflowExecutions.workflowVersionId)
          )
          .where(
            includeSuperseded
              ? eq(workflowExecutions.workflowId, workflowId)
              : and(
                  eq(workflowExecutions.workflowId, workflowId),
                  ne(workflowExecutions.status, "superseded")
                )
          )
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
          .limit(WORKFLOW_EXECUTIONS_LIMIT)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionListRow)))
      ),
    countSuperseded: (workflowId) =>
      store.read((database) =>
        database
          .select({ total: sql<number>`count(*)` })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              eq(workflowExecutions.status, "superseded")
            )
          )
          .get()
          .pipe(
            Effect.map((row) => {
              if (!row) throw new Error("Invalid SQLite count");
              return row.total;
            })
          )
      ),
    listPage: (query) =>
      store.read((database) => {
        const filters: SQL[] = [];
        if (query.workflowIds?.length) {
          filters.push(
            inArray(workflowExecutions.workflowId, query.workflowIds)
          );
        }
        if (query.statuses?.length) {
          const statusFilter = inArray(
            workflowExecutions.status,
            query.statuses
          );
          if (statusFilter) filters.push(statusFilter);
        }
        if (query.cursor) {
          const startedAt = query.cursor.startedAt.getTime();
          const cursorFilter = or(
            lt(workflowExecutions.startedAt, startedAt),
            and(
              eq(workflowExecutions.startedAt, startedAt),
              lt(workflowExecutions.id, query.cursor.id)
            )
          );
          if (cursorFilter) filters.push(cursorFilter);
        }
        return database
          .select({
            ...executionListSelection,
            workflowName: workflows.name,
            workflowIsPaused: workflows.isPaused,
          })
          .from(workflowExecutions)
          .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
          .innerJoin(
            workflowVersions,
            eq(workflowVersions.id, workflowExecutions.workflowVersionId)
          )
          .where(filters.length === 0 ? undefined : and(...filters))
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
          .limit(query.limit)
          .pipe(Effect.map((rows) => rows.map(globalExecution)));
      }),
    findSummaryById: (executionId) =>
      store.read((database) =>
        database
          .select({
            execution: workflowExecutions,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
          })
          .from(workflowExecutions)
          .innerJoin(
            workflowVersions,
            eq(workflowVersions.id, workflowExecutions.workflowVersionId)
          )
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(
            Effect.map((row) =>
              row
                ? executionSummary({
                    ...row.execution,
                    versionKind: row.versionKind,
                    versionNumber: row.versionNumber,
                  })
                : null
            )
          )
      ),
    findStatusById: (executionId) =>
      store.read((database) =>
        database
          .select({
            id: workflowExecutions.id,
            status: workflowExecutions.status,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(
            Effect.map((row) =>
              row
                ? { id: row.id, status: sqliteExecutionStatus(row.status) }
                : null
            )
          )
      ),
    existsById: (executionId) =>
      store.read((database) =>
        database
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1)
          .get()
          .pipe(Effect.map(Boolean))
      ),
    findWorkflowIdById: (executionId) =>
      store.read((database) =>
        database
          .select({ workflowId: workflowExecutions.workflowId })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(Effect.map((row) => row?.workflowId ?? null))
      ),
    insertTerminal: (input) =>
      store.write((database) =>
        insertExecution(database, input, input.status, input)
      ),
    markEnqueued: ({ executionId, runId }) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({ workflowRunId: runId, enqueuedAt: Date.now() })
          .where(eq(workflowExecutions.id, executionId))
      ),
    markEnqueueFailed: ({ executionId, error }) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({
            status: "failed",
            error,
            completedAt: Date.now(),
            waitingAt: null,
          })
          .where(
            and(
              eq(workflowExecutions.id, executionId),
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    markRunning: (executionId) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({ status: "running", waitingAt: null })
          .where(
            and(
              eq(workflowExecutions.id, executionId),
              eq(workflowExecutions.status, "waiting")
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    endInFlight: (input) =>
      store.write((database) => {
        const now = Date.now();
        return database
          .update(workflowExecutions)
          .set({
            status: input.status,
            waitingAt: null,
            cancelledAt: input.status === "canceled" ? now : null,
            completedAt: now,
            error: input.error ?? null,
          })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0));
      }),
    requestCancelForEntity: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const where = and(
            eq(workflowExecutions.workflowId, input.workflowId),
            eq(workflowExecutions.entityValue, input.entityValue),
            eq(workflowExecutions.runMode, input.runMode),
            inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
            isNull(workflowExecutions.cancelRequestedAt)
          );
          const rows = yield* database
            .select({ id: workflowExecutions.id })
            .from(workflowExecutions)
            .where(where);
          yield* database
            .update(workflowExecutions)
            .set({
              cancelRequestedAt: Date.now(),
              cancelEventName: input.eventName,
              cancelPayload: encodeJson(input.payload),
            })
            .where(where);
          return rows.map((row) => row.id);
        })
      ),
    findPendingCancel: (executionId) =>
      store.read((database) =>
        database
          .select({
            cancelRequestedAt: workflowExecutions.cancelRequestedAt,
            cancelEventName: workflowExecutions.cancelEventName,
            cancelPayload: workflowExecutions.cancelPayload,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(
            Effect.map((row) => {
              if (!row || row.cancelRequestedAt === null) return null;
              return {
                eventName: row.cancelEventName,
                payload: optionalJsonObject(row.cancelPayload),
              };
            })
          )
      ),
    finishRun: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const row = yield* database
            .select({ startedAt: workflowExecutions.startedAt })
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, input.executionId))
            .get();
          if (!row) return false;
          const now = Date.now();
          const updated = yield* database
            .update(workflowExecutions)
            .set({
              status: input.status,
              output: encodeJson(input.output),
              error: input.error ?? null,
              waitingAt: null,
              completedAt: now,
              duration: String(now - row.startedAt),
            })
            .where(
              and(
                eq(workflowExecutions.id, input.executionId),
                inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
              )
            )
            .returning({ id: workflowExecutions.id });
          return updated.length > 0;
        })
      ),
  };
}
