import { Effect } from "effect";
import {
  and,
  asc,
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
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  isoTerminationClaim,
  TERMINAL_EXECUTION_STATUSES,
  type ExecutionSide,
  type TerminalExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { RunsRepoMethods } from "#src/backend/services/executions/repo/runs";
import {
  decideRunEnd,
  type RunEndAnswer,
  type RunEnding,
} from "@wfgraph/shared/lifecycle/run-ending";
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
import { settleEndedExecutions } from "#src/backend/persistence/sqlite/executions/schedule";
import {
  recordAuditEventsWrite,
  recordAuditEventWrite,
} from "#src/backend/persistence/sqlite/executions/audit";

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
  error: workflowExecutions.error,
  startedAt: workflowExecutions.startedAt,
  scheduledFor: workflowExecutions.scheduledFor,
  scheduleCron: workflowExecutions.scheduleCron,
  scheduleTimeZone: workflowExecutions.scheduleTimeZone,
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
    const isTerminal = TERMINAL_EXECUTION_STATUSES.includes(status);
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
        scheduledFor: input.scheduled?.slot.getTime() ?? null,
        scheduleCron: input.scheduled?.schedule.cron ?? null,
        scheduleTimeZone: input.scheduled?.schedule.timeZone ?? null,
        cancelledAt: status === "canceled" ? now : null,
        completedAt: isTerminal ? now : null,
        duration: isTerminal ? "0" : null,
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
    scheduledFor: execution.scheduledFor,
    scheduleCron: execution.scheduleCron,
    scheduleTimeZone: execution.scheduleTimeZone,
    completedAt: execution.completedAt,
    duration: execution.duration,
  };
}

/**
 * `claimKindAdmits` as a condition on the execution row, which is where every
 * guarded write asks it.
 */
export function claimAdmits(side: ExecutionSide): SQL {
  return side === "canceled"
    ? eq(workflowExecutions.terminationKind, "cancel")
    : isNull(workflowExecutions.terminationKind);
}

/**
 * The guard a write carries when it serves both sides and cannot say which one
 * it is for: whatever either side admits, which is every claim but an Exit.
 *
 * Written as one `sql` chunk because drizzle's `or` answers `SQL | undefined`
 * for any argument list, and a guard this is always part of should not be
 * optional at its call sites.
 */
export const notExitClaimed: SQL = sql`(${claimAdmits("started")} or ${claimAdmits("canceled")})`;

function inFlightExecutionRow(row: {
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
          .pipe(Effect.map((rows) => rows.map(inFlightExecutionRow)))
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
    findByDelivery: (input) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, input.workflowId),
              eq(workflowExecutions.deliveryId, input.deliveryId)
            )
          )
          .get()
          .pipe(Effect.map((row) => (row ? sqliteExecution(row) : null)))
      ),
    insertTerminal: ({ announcement, ...input }) =>
      store.write((database) =>
        Effect.gen(function* () {
          const execution = yield* insertExecution(
            database,
            input,
            input.status,
            input
          );
          yield* recordAuditEventWrite({
            ...announcement,
            workflowId: input.workflowId,
            executionId: execution.id,
          })(database);
          return execution;
        })
      ),
    markRunning: (input) => store.write(markRunningWrite(input)),
    markWaitingIfParked: (input) =>
      store.write(markWaitingIfParkedWrite(input)),
    cancelRun: ({ executionId, ...cancel }) =>
      store.write((database) =>
        endOneRunWrite(database, {
          executionId,
          ending: { kind: "cancel", ...cancel },
        })
      ),
    requestExit: (input) => store.write(requestExitWrite(input)),
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
    endRun: (input) => store.write(endRunWrite(input)),
  };
}

type MarkRunningInput = Parameters<RunsRepoMethods["markRunning"]>[0];
type MarkWaitingIfParkedInput = Parameters<
  RunsRepoMethods["markWaitingIfParked"]
>[0];
type RequestExitInput = Parameters<RunsRepoMethods["requestExit"]>[0];
type EndRunInput = Parameters<RunsRepoMethods["endRun"]>[0];

/**
 * The boundary a guarded write answers: the row it wrote when its guard
 * admitted the row, and otherwise the row as stored, or null when the row is
 * absent.
 */
function writtenOrStored(
  database: SqliteExecutor,
  executionId: string,
  written: typeof workflowExecutions.$inferSelect | undefined
) {
  if (written) return Effect.succeed(terminationState(written, true));
  return database
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .get()
    .pipe(Effect.map((row) => (row ? terminationState(row) : null)));
}

/** The update behind `markRunning`, inside the caller's write transaction. */
export function markRunningWrite(input: MarkRunningInput) {
  return (database: SqliteExecutor) =>
    database
      .update(workflowExecutions)
      .set({ status: "running", waitingAt: null })
      .where(
        and(
          eq(workflowExecutions.id, input.executionId),
          eq(workflowExecutions.workflowVersionId, input.workflowVersionId),
          inArray(workflowExecutions.status, ["waiting", "running"]),
          claimAdmits(input.side)
        )
      )
      .returning({ id: workflowExecutions.id })
      .pipe(Effect.map((rows) => rows.length > 0));
}

/** The update behind `markWaitingIfParked`. */
export function markWaitingIfParkedWrite(input: MarkWaitingIfParkedInput) {
  return (database: SqliteExecutor) =>
    database
      .update(workflowExecutions)
      .set({ status: "waiting", waitingAt: Date.now() })
      .where(
        and(
          eq(workflowExecutions.id, input.executionId),
          eq(workflowExecutions.status, "running"),
          notExitClaimed,
          stillParked()
        )
      )
      .returning({ id: workflowExecutions.id })
      .pipe(Effect.map((rows) => rows.length > 0));
}

/** The update behind `requestExit`. */
export function requestExitWrite(input: RequestExitInput) {
  return (database: SqliteExecutor) =>
    Effect.gen(function* () {
      const [written] = yield* database
        .update(workflowExecutions)
        .set({
          terminationKind: "exit",
          terminationRequestedAt: input.requestedAt?.getTime() ?? Date.now(),
          terminationReason: input.reason,
          terminationNodeId: input.nodeId,
        })
        .where(
          and(
            eq(workflowExecutions.id, input.executionId),
            inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
            isNull(workflowExecutions.terminationKind)
          )
        )
        .returning();
      return yield* writtenOrStored(database, input.executionId, written);
    });
}

/**
 * The columns every update that ends a run sets beside its own, so no ended
 * run is missing a completion time or a duration.
 */
function endedRunColumns(status: TerminalExecutionStatus) {
  const now = Date.now();
  return {
    status,
    waitingAt: null,
    cancelledAt: status === "canceled" ? now : null,
    completedAt: now,
    // node:sqlite binds a JS number as REAL, so the difference is cast to an
    // integer first, or the text would read "5.0".
    duration: sql<string>`cast(cast(${now} - ${workflowExecutions.startedAt} as integer) as text)`,
  };
}

export function endRunWrite(input: EndRunInput) {
  return (database: SqliteExecutor) => endOneRunWrite(database, input);
}

/**
 * The one write that ends runs, inside the caller's write transaction, as the
 * PostgreSQL backend's `endRunsWrite` describes. The transaction holds the one
 * writer from its first statement, so the read each decision stands on cannot
 * change before its write.
 */
export function endRunsWrite(
  database: SqliteExecutor,
  input: {
    executionIds: readonly string[];
    ending: RunEnding;
    output?: JsonValue | undefined;
  }
): Effect.Effect<{ executionId: string; answer: RunEndAnswer }[], unknown> {
  const ids = [...input.executionIds];
  if (ids.length === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const runs = yield* database
      .select()
      .from(workflowExecutions)
      .where(inArray(workflowExecutions.id, ids))
      .orderBy(asc(workflowExecutions.id));
    const decided = runs.map((run) => {
      const stored = terminationState(run);
      return {
        run,
        stored,
        decision: decideRunEnd(input.ending, {
          status: stored.status,
          claim: stored.claim && isoTerminationClaim(stored.claim),
          runMode: sqliteExecution(run).runMode,
        }),
      };
    });
    const ended = decided.flatMap(({ run, decision }) =>
      decision.kind === "write" ? [{ run, decision }] : []
    );
    yield* Effect.forEach(
      ended,
      ({ run, decision }) =>
        database
          .update(workflowExecutions)
          .set({
            ...endedRunColumns(decision.status),
            output: encodeJson(input.output),
            error: decision.error ?? null,
          })
          .where(
            and(
              eq(workflowExecutions.id, run.id),
              eq(workflowExecutions.status, run.status),
              run.terminationKind === null
                ? isNull(workflowExecutions.terminationKind)
                : eq(workflowExecutions.terminationKind, run.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(
            Effect.flatMap(([written]) =>
              written
                ? Effect.void
                : Effect.die(
                    new Error("A run changed under the write its ending holds")
                  )
            )
          ),
      { discard: true }
    );
    yield* recordAuditEventsWrite(
      ended.map(({ run, decision }) => ({
        ...decision.entry,
        workflowId: run.workflowId,
        executionId: run.id,
      }))
    )(database);
    yield* settleEndedExecutions(
      database,
      ended.map(({ run }) => run.id)
    );
    return decided.map(({ run, decision }) => ({
      executionId: run.id,
      answer:
        decision.kind === "write"
          ? ({ kind: "ended", status: decision.status } as const)
          : decision,
    }));
  });
}

/** `endRunsWrite` for one run, answering `missing` when no row holds its id. */
function endOneRunWrite(
  database: SqliteExecutor,
  input: {
    executionId: string;
    ending: RunEnding;
    output?: JsonValue | undefined;
  }
): Effect.Effect<RunEndAnswer, unknown> {
  return endRunsWrite(database, {
    executionIds: [input.executionId],
    ending: input.ending,
    output: input.output,
  }).pipe(
    Effect.map(([run]): RunEndAnswer => run?.answer ?? { kind: "missing" })
  );
}
