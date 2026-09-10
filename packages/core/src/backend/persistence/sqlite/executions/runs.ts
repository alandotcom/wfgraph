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
  ExecutionTerminationState,
  GlobalExecutionRow,
  InFlightExecutionRow,
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
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";
import {
  sqliteExecution,
  sqliteExecutionListRow,
  sqliteExecutionStatus,
  sqliteVersionKind,
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

/**
 * Whether the execution still holds a wait row in `waiting`. Correlated against
 * the execution row, so the statement it guards evaluates it.
 */
function stillParked(): SQL {
  return sql`exists (
    select 1 from ${workflowWaitStates}
    where ${workflowWaitStates.executionId} = ${workflowExecutions.id}
      and ${workflowWaitStates.status} = 'waiting'
  )`;
}

function optionalJsonObject(value: string | null) {
  if (value === null) return null;
  const json = readJsonObject(JSON.parse(value));
  if (json === null) throw new Error("Invalid SQLite cancel_payload");
  return json;
}

function terminationState(
  row: typeof workflowExecutions.$inferSelect,
  didWrite = false
): ExecutionTerminationState {
  const execution = sqliteExecution(row);
  if (execution.terminationKind === null) {
    return {
      executionId: execution.id,
      status: execution.status,
      claim: null,
      didWrite,
    };
  }
  const requestedAt = execution.terminationRequestedAt;
  if (requestedAt === null) {
    throw new Error("SQLite execution termination claim has no timestamp");
  }
  if (execution.terminationKind === "cancel") {
    return {
      executionId: execution.id,
      status: execution.status,
      claim: {
        kind: "cancel",
        requestedAt,
        eventName: execution.cancelEventName,
        payload: execution.cancelPayload,
      },
      didWrite,
    };
  }
  if (
    execution.terminationReason === null ||
    execution.terminationNodeId === null
  ) {
    throw new Error("SQLite execution exit claim is incomplete");
  }
  return {
    executionId: execution.id,
    status: execution.status,
    claim: {
      kind: "exit",
      requestedAt,
      reason: execution.terminationReason,
      nodeId: execution.terminationNodeId,
    },
    didWrite,
  };
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
      status === "completed" ||
      status === "failed" ||
      status === "canceled" ||
      status === "exited";
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
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
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
    entityType: execution.entityType,
    entityId: execution.entityId,
    input: execution.input,
    output: execution.output,
    error: execution.error,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    duration: execution.duration,
  };
}

function inFlightExecution(row: {
  id: string;
  status: string;
  workflowVersionId: string;
  versionKind: string;
  versionNumber: number | null;
  entityType: string | null;
  entityId: string | null;
}): InFlightExecutionRow {
  return {
    id: row.id,
    status: sqliteExecutionStatus(row.status),
    workflowVersionId: row.workflowVersionId,
    versionKind: sqliteVersionKind(row.versionKind),
    versionNumber: row.versionNumber,
    entityType: row.entityType,
    entityId: row.entityId,
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
    listInFlightByWorkflow: (workflowId) =>
      store.read((database) =>
        database
          .select({
            id: workflowExecutions.id,
            status: workflowExecutions.status,
            workflowVersionId: workflowExecutions.workflowVersionId,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
            entityType: workflowExecutions.entityType,
            entityId: workflowExecutions.entityId,
          })
          .from(workflowExecutions)
          .innerJoin(
            workflowVersions,
            eq(workflowVersions.id, workflowExecutions.workflowVersionId)
          )
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
          .pipe(Effect.map((rows) => rows.map(inFlightExecution)))
      ),
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
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    repinVersion: (input) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({ workflowVersionId: input.toVersionId })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.status, "waiting"),
              eq(workflowExecutions.workflowVersionId, input.fromVersionId),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    markRunning: (input) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({ status: "running", waitingAt: null })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.workflowVersionId, input.workflowVersionId),
              inArray(workflowExecutions.status, ["waiting", "running"]),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    markWaitingIfParked: (input) =>
      store.write((database) =>
        database
          .update(workflowExecutions)
          .set({ status: "waiting", waitingAt: Date.now() })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.status, "running"),
              isNull(workflowExecutions.terminationKind),
              stillParked()
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),
    endInFlight: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          const updated = yield* database
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
                inArray(
                  workflowExecutions.status,
                  IN_FLIGHT_EXECUTION_STATUSES
                ),
                isNull(workflowExecutions.terminationKind)
              )
            )
            .returning();
          const [written] = updated;
          if (written) return terminationState(written, true);

          const current = yield* database
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, input.executionId))
            .get();
          return current ? terminationState(current) : null;
        })
      ),
    requestCancelForEntity: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const requestedAt = Date.now();
          const entityPredicate =
            input.entityType === undefined
              ? eq(workflowExecutions.entityValue, input.entityValue)
              : and(
                  eq(workflowExecutions.entityType, input.entityType),
                  eq(workflowExecutions.entityId, input.entityId)
                );
          const where = and(
            eq(workflowExecutions.workflowId, input.workflowId),
            entityPredicate,
            eq(workflowExecutions.runMode, input.runMode),
            inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
            isNull(workflowExecutions.terminationKind)
          );
          const flagged = yield* database
            .update(workflowExecutions)
            .set({
              terminationKind: "cancel",
              terminationRequestedAt: requestedAt,
              cancelEventName: input.eventName,
              cancelPayload: encodeJson(input.payload),
            })
            .where(where)
            .returning({ id: workflowExecutions.id });
          return flagged.map((row) => row.id);
        })
      ),
    requestExit: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const updated = yield* database
            .update(workflowExecutions)
            .set({
              terminationKind: "exit",
              terminationRequestedAt:
                input.requestedAt?.getTime() ?? Date.now(),
              terminationReason: input.reason,
              terminationNodeId: input.nodeId,
            })
            .where(
              and(
                eq(workflowExecutions.id, input.executionId),
                inArray(
                  workflowExecutions.status,
                  IN_FLIGHT_EXECUTION_STATUSES
                ),
                isNull(workflowExecutions.terminationKind)
              )
            )
            .returning();
          const [written] = updated;
          if (written) return terminationState(written, true);

          const current = yield* database
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, input.executionId))
            .get();
          return current ? terminationState(current) : null;
        })
      ),
    canAdmitNode: (executionId) =>
      store.read((database) =>
        database
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.id, executionId),
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .get()
          .pipe(Effect.map((row) => row !== undefined))
      ),
    findTerminationState: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(Effect.map((row) => (row ? terminationState(row) : null)))
      ),
    findPendingCancel: (executionId) =>
      store.read((database) =>
        database
          .select({
            terminationKind: workflowExecutions.terminationKind,
            cancelEventName: workflowExecutions.cancelEventName,
            cancelPayload: workflowExecutions.cancelPayload,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .get()
          .pipe(
            Effect.map((row) => {
              if (!row || row.terminationKind !== "cancel") return null;
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
          const claimGuard =
            input.status === "canceled"
              ? eq(workflowExecutions.terminationKind, "cancel")
              : input.status === "exited"
                ? eq(workflowExecutions.terminationKind, "exit")
                : isNull(workflowExecutions.terminationKind);
          const now = Date.now();
          const updated = yield* database
            .update(workflowExecutions)
            .set({
              status: input.status,
              output: encodeJson(input.output),
              error: input.error ?? null,
              waitingAt: null,
              cancelledAt: input.status === "canceled" ? now : null,
              completedAt: now,
              duration: sql`cast(${now} - ${workflowExecutions.startedAt} as text)`,
            })
            .where(
              and(
                eq(workflowExecutions.id, input.executionId),
                inArray(
                  workflowExecutions.status,
                  IN_FLIGHT_EXECUTION_STATUSES
                ),
                claimGuard
              )
            )
            .returning();
          const [written] = updated;
          if (written) return terminationState(written, true);

          const current = yield* database
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, input.executionId))
            .get();
          return current ? terminationState(current) : null;
        })
      ),
  };
}
