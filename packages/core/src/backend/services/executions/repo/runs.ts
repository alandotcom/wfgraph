import {
  and,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Effect } from "effect";
import {
  workflowExecutions,
  workflows,
  workflowVersions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";
import type {
  ExecutionEntitySelector,
  ExecutionPageQuery,
  ExecutionStatusRow,
  ExecutionSummary,
  ExecutionTerminationState,
  GlobalExecutionRow,
  InFlightExecutionRow,
  NewTerminalExecution,
  PendingCancel,
  WorkflowExecution,
  WorkflowExecutionListRow,
} from "#src/backend/services/executions/repo/contracts";

/**
 * The columns both run-list queries select, plus the two they join for.
 *
 * JSONB payloads and the routing columns the lists never paint stay off this
 * list, so a poll does not pull TOAST the panel would discard. `versionKind` and
 * `versionNumber` come from the version the run pinned, looked up by primary
 * key, so the panel can label a run's graph without reading the graph.
 */
const EXECUTION_LIST_COLUMNS = {
  id: workflowExecutions.id,
  workflowId: workflowExecutions.workflowId,
  status: workflowExecutions.status,
  startSource: workflowExecutions.startSource,
  runMode: workflowExecutions.runMode,
  startEventName: workflowExecutions.startEventName,
  entityValue: workflowExecutions.entityValue,
  workflowRunId: workflowExecutions.workflowRunId,
  versionKind: workflowVersions.kind,
  versionNumber: workflowVersions.version,
  error: workflowExecutions.error,
  startedAt: workflowExecutions.startedAt,
  waitingAt: workflowExecutions.waitingAt,
  cancelledAt: workflowExecutions.cancelledAt,
  completedAt: workflowExecutions.completedAt,
  duration: workflowExecutions.duration,
} as const satisfies Record<keyof WorkflowExecutionListRow, PgColumn>;

/** Join condition for the pinned version. Every execution pins exactly one. */
const pinnedVersion = eq(
  workflowExecutions.workflowVersionId,
  workflowVersions.id
);

/** The most recent runs one workflow's panel shows. */
const WORKFLOW_EXECUTIONS_LIMIT = 50;

/**
 * The compare-and-set every write that ends or parks a run from outside it
 * carries: only a run that has not reached a verdict may be moved.
 *
 * Shared with `waits.ts`, whose `startWait` parks a run behind the same guard.
 */
export function inFlightExecution(executionId: string): SQL | undefined {
  return and(
    eq(workflowExecutions.id, executionId),
    inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES]),
    isNull(workflowExecutions.terminationKind)
  );
}

const TERMINATION_COLUMNS = {
  executionId: workflowExecutions.id,
  status: workflowExecutions.status,
  kind: workflowExecutions.terminationKind,
  requestedAt: workflowExecutions.terminationRequestedAt,
  reason: workflowExecutions.terminationReason,
  nodeId: workflowExecutions.terminationNodeId,
  eventName: workflowExecutions.cancelEventName,
  payload: workflowExecutions.cancelPayload,
} as const;

type TerminationRow = {
  executionId: string;
  status: WorkflowExecution["status"];
  kind: "cancel" | "exit" | null;
  requestedAt: Date | null;
  reason: "entity_condition_not_met" | "entity_not_found" | null;
  nodeId: string | null;
  eventName: string | null;
  payload: JsonObject | null;
};

function executionTerminationState(
  row: TerminationRow,
  didWrite = false
): ExecutionTerminationState {
  if (row.kind === null) {
    return {
      executionId: row.executionId,
      status: row.status,
      claim: null,
      didWrite,
    };
  }
  if (row.requestedAt === null) {
    throw new Error("Execution termination claim has no timestamp");
  }
  if (row.kind === "cancel") {
    return {
      executionId: row.executionId,
      status: row.status,
      claim: {
        kind: "cancel",
        requestedAt: row.requestedAt,
        eventName: row.eventName,
        payload: row.payload,
      },
      didWrite,
    };
  }
  if (row.reason === null || row.nodeId === null) {
    throw new Error("Execution exit claim is incomplete");
  }
  return {
    executionId: row.executionId,
    status: row.status,
    claim: {
      kind: "exit",
      requestedAt: row.requestedAt,
      reason: row.reason,
      nodeId: row.nodeId,
    },
    didWrite,
  };
}

function buildPageFilters(query: ExecutionPageQuery): SQL[] {
  const filters: SQL[] = [];

  if (query.workflowIds && query.workflowIds.length > 0) {
    filters.push(inArray(workflowExecutions.workflowId, query.workflowIds));
  }

  if (query.statuses && query.statuses.length > 0) {
    filters.push(inArray(workflowExecutions.status, query.statuses));
  }

  if (query.cursor) {
    // Ordering is by start time and then id, so resuming after a row means
    // everything older, plus the ties that sort below it.
    const cursorFilter = or(
      lt(workflowExecutions.startedAt, query.cursor.startedAt),
      and(
        eq(workflowExecutions.startedAt, query.cursor.startedAt),
        lt(workflowExecutions.id, query.cursor.id)
      )
    );
    if (cursorFilter) {
      filters.push(cursorFilter);
    }
  }

  return filters;
}

/** The `workflow_executions` slice of `ExecutionRepo`. */
export type RunsRepoMethods = {
  /**
   * One workflow's most recent runs, newest first.
   *
   * Superseded runs are left out unless asked for: a newest-wins workflow
   * supersedes a run on every reschedule, and those rows would crowd the ones
   * the panel was opened for out of the row cap. The panel's toggle is what
   * asks, and `countSuperseded` is what labels it.
   */
  readonly listByWorkflow: (input: {
    workflowId: string;
    includeSuperseded: boolean;
  }) => Effect.Effect<WorkflowExecutionListRow[], DatabaseError>;
  /** How many runs of this workflow a newer start displaced. */
  readonly countSuperseded: (
    workflowId: string
  ) => Effect.Effect<number, DatabaseError>;
  /**
   * One page of runs across every workflow, newest first, each row carrying
   * the name and paused flag of the workflow it belongs to.
   */
  readonly listPage: (
    query: ExecutionPageQuery
  ) => Effect.Effect<GlobalExecutionRow[], DatabaseError>;
  /**
   * Every in-flight run of one workflow, in the columns a Migration classifies
   * from.
   *
   * Unpaged, because a Migration's verdict is about the whole set: the report
   * counts the runs already on the target version beside the ones it can move,
   * and a page boundary would split that count.
   */
  readonly listInFlightByWorkflow: (
    workflowId: string
  ) => Effect.Effect<InFlightExecutionRow[], DatabaseError>;
  /** One run as the logs view paints it (status, timing, and start identity). */
  readonly findSummaryById: (
    executionId: string
  ) => Effect.Effect<ExecutionSummary | null, DatabaseError>;
  /** Where one run got to, the smallest answer the status poll can be given. */
  readonly findStatusById: (
    executionId: string
  ) => Effect.Effect<ExecutionStatusRow | null, DatabaseError>;
  /** Whether the run is there at all, for the paths that only report absence. */
  readonly existsById: (
    executionId: string
  ) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Which workflow a run belongs to, which is all the cancel path needs of the
   * run itself before it starts writing audit rows against the workflow.
   */
  readonly findWorkflowIdById: (
    executionId: string
  ) => Effect.Effect<string | null, DatabaseError>;
  /** Record a run that never started, already in its terminal status. */
  readonly insertTerminal: (
    input: NewTerminalExecution
  ) => Effect.Effect<WorkflowExecution, DatabaseError>;
  /**
   * Record that the bus took this run, with the Inngest event id it answered
   * with.
   *
   * The stamp is what separates a run Inngest is executing from a row whose
   * process died before the send, which is the only thing that makes a stuck
   * row recoverable: an unstamped row past `UNSENT_RUN_GRACE_MS` is one the
   * next start for its entity may close.
   */
  readonly markEnqueued: (input: {
    executionId: string;
    runId: string | null;
  }) => Effect.Effect<void, DatabaseError>;
  /**
   * Close a run whose enqueue was refused, answering whether a row was
   * written. Without it the row sits in "running" with nothing behind it that
   * could ever finish it.
   *
   * The in-flight guard defers to a terminal status and nothing more, so a run
   * Inngest accepted and started milliseconds ago is still `running` and this
   * write would relabel it. What makes the ambiguity safe is the cancel the
   * caller sends first: a run that did start is stopped, and one that never
   * started ignores a signal addressed to it.
   */
  readonly markEnqueueFailed: (input: {
    executionId: string;
    error: string;
  }) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Move a parked run's pinned version pointer, answering whether a row moved.
   *
   * The guard is the whole of the safety: only a row still `waiting` and still
   * on `fromVersionId` is written, so a run that woke, ended, or was already
   * moved by another caller keeps the version it is executing against.
   */
  readonly repinVersion: (input: {
    executionId: string;
    fromVersionId: string;
    toVersionId: string;
  }) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Move a run back from "waiting" to "running" under the version the caller
   * loaded, answering whether a row moved.
   *
   * The version is the fence a resuming Wait relies on: a Migration that lands
   * between the wake and this write leaves the row pinned to another version,
   * no row is written, and the caller starts again against the new pointer.
   *
   * Only `waiting` and `running` are accepted starting statuses. `waiting` is
   * the run this resume woke. `running` is a sibling Wait of the same run having
   * already written it, which is routine when two branches wake together. A
   * `pending` run has not reached a Wait, so a resume finding one is addressing
   * a row nothing parked.
   */
  readonly markRunning: (input: {
    executionId: string;
    workflowVersionId: string;
  }) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Move a `running` run back to `waiting` when it still holds a waiting wait
   * row, answering whether a row moved.
   *
   * Only a park writes `waiting`, so a run whose branch resumed and finished
   * while a sibling branch stayed parked would read `running` until that sibling
   * woke. The guard is what keeps this from parking a run with nothing left
   * waiting: the wait-row test and the status test are one statement, so a park
   * or a resume landing beside it cannot be overtaken.
   */
  readonly markWaitingIfParked: (input: {
    executionId: string;
  }) => Effect.Effect<boolean, DatabaseError>;
  /**
   * End a run from outside it, answering whether this write is the one that
   * made the row terminal.
   *
   * Compare-and-set, because a running execution routinely completes between a
   * candidate query and this write and the finished row keeps its own status.
   * `canceled` is an operator or a Cancel Event stopping the run, so it stamps
   * `cancelledAt`; `superseded` is newest-wins Concurrency letting a newer
   * start take this run's place, which is routine and not a cancellation.
   */
  readonly endInFlight: (input: {
    executionId: string;
    status: "canceled" | "superseded";
    error?: string | undefined;
  }) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
  /**
   * Flag every in-flight run of this workflow about this entity for the
   * Canceled outlet, answering the ids flagged.
   *
   * One statement, because the candidate read and the write are the same
   * decision: a run that reaches a verdict in between must not be flagged, and
   * the in-flight guard is what says so. A run already flagged is skipped, so
   * the first Cancel Event owns the payload the Canceled branch runs against.
   * The rows keep their status -- a cancellation is a routed continuation, so
   * the run ends itself once it has read the flag at its next node boundary.
   */
  readonly requestCancelForEntity: (
    input: {
      workflowId: string;
      runMode: WorkflowExecution["runMode"];
      eventName: string;
      payload: JsonObject;
    } & ExecutionEntitySelector
  ) => Effect.Effect<string[], DatabaseError>;
  /**
   * Atomically claims an execution-wide Entity Eligibility exit and returns the
   * authoritative stored boundary, including an earlier competing outcome.
   */
  readonly requestExit: (input: {
    executionId: string;
    reason: "entity_condition_not_met" | "entity_not_found";
    nodeId: string;
  }) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
  /** The authoritative boundary state, or null when the execution is absent. */
  readonly findTerminationState: (
    executionId: string
  ) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
  /** The cancel a run was flagged with, or null when it carries none. */
  readonly findPendingCancel: (
    executionId: string
  ) => Effect.Effect<PendingCancel | null, DatabaseError>;
  /**
   * Write the run's own terminal row, answering whether this write recorded
   * it. The same in-flight guard as `endInFlight`: a cancel can flip the row
   * while the run is finishing its last step, and the losing completion must
   * not resurrect it.
   */
  readonly finishRun: (input: {
    executionId: string;
    status: "completed" | "failed" | "canceled" | "exited";
    output?: JsonValue | undefined;
    error?: string | undefined;
  }) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
};

/** Builds the `workflow_executions` slice of `ExecutionRepo` over one database. */
export function makeRunsMethods(
  database: Database["Service"]
): RunsRepoMethods {
  return {
    listByWorkflow: ({ workflowId, includeSuperseded }) =>
      database.query((db) =>
        db
          .select(EXECUTION_LIST_COLUMNS)
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              includeSuperseded
                ? undefined
                : ne(workflowExecutions.status, "superseded")
            )
          )
          .orderBy(desc(workflowExecutions.startedAt))
          .limit(WORKFLOW_EXECUTIONS_LIMIT)
      ),

    countSuperseded: (workflowId) =>
      database.query(async (db) => {
        const [row] = await db
          .select({ total: count() })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              eq(workflowExecutions.status, "superseded")
            )
          );

        return row?.total ?? 0;
      }),

    listPage: (query) =>
      database.query((db) => {
        const filters = buildPageFilters(query);

        return db
          .select({
            ...EXECUTION_LIST_COLUMNS,
            workflowName: workflows.name,
            workflowIsPaused: workflows.isPaused,
          })
          .from(workflowExecutions)
          .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
          .innerJoin(workflowVersions, pinnedVersion)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
          .limit(query.limit);
      }),

    listInFlightByWorkflow: (workflowId) =>
      database.query((db) =>
        db
          .select({
            id: workflowExecutions.id,
            status: workflowExecutions.status,
            workflowVersionId: workflowExecutions.workflowVersionId,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
          })
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
      ),

    findSummaryById: (executionId) =>
      database.query(async (db) => {
        const [execution] = await db
          .select({
            id: workflowExecutions.id,
            workflowId: workflowExecutions.workflowId,
            workflowVersionId: workflowExecutions.workflowVersionId,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
            status: workflowExecutions.status,
            startSource: workflowExecutions.startSource,
            runMode: workflowExecutions.runMode,
            startEventName: workflowExecutions.startEventName,
            entityValue: workflowExecutions.entityValue,
            input: workflowExecutions.input,
            output: workflowExecutions.output,
            error: workflowExecutions.error,
            startedAt: workflowExecutions.startedAt,
            completedAt: workflowExecutions.completedAt,
            duration: workflowExecutions.duration,
          })
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        return execution ?? null;
      }),

    findStatusById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { id: true, status: true },
        });

        return execution ?? null;
      }),

    existsById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { id: true },
        });

        return execution !== undefined;
      }),

    findWorkflowIdById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { workflowId: true },
        });

        return execution?.workflowId ?? null;
      }),

    insertTerminal: (input) =>
      database.query(async (db) => {
        const now = new Date();
        const [execution] = await db
          .insert(workflowExecutions)
          .values({
            workflowId: input.workflowId,
            workflowVersionId: input.workflowVersionId,
            status: input.status,
            startSource: input.startSource,
            runMode: input.runMode,
            startEventName: input.startEventName,
            entityValue: input.entityValue,
            entityType: input.entityType,
            entityId: input.entityId,
            input: input.input,
            output: input.output,
            error: input.error,
            startedAt: now,
            completedAt: now,
            cancelledAt: input.status === "canceled" ? now : null,
          })
          .returning();

        return execution;
      }),

    markEnqueued: (input) =>
      database.query(async (db) => {
        await db
          .update(workflowExecutions)
          .set({ workflowRunId: input.runId, enqueuedAt: new Date() })
          .where(eq(workflowExecutions.id, input.executionId));
      }),

    markEnqueueFailed: (input) =>
      database.query(async (db) => {
        const closed = await db
          .update(workflowExecutions)
          .set({
            status: "failed",
            error: input.error,
            completedAt: new Date(),
          })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id });

        return closed.length > 0;
      }),

    repinVersion: (input) =>
      database.query(async (db) => {
        const moved = await db
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
          .returning({ id: workflowExecutions.id });

        return moved.length > 0;
      }),

    markRunning: (input) =>
      database.query(async (db) => {
        const moved = await db
          .update(workflowExecutions)
          .set({ status: "running", waitingAt: null })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              inArray(workflowExecutions.status, ["waiting", "running"]),
              eq(workflowExecutions.workflowVersionId, input.workflowVersionId),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id });

        return moved.length > 0;
      }),

    markWaitingIfParked: (input) =>
      database.query(async (db) => {
        const parked = await db
          .update(workflowExecutions)
          .set({ status: "waiting", waitingAt: new Date() })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              eq(workflowExecutions.status, "running"),
              isNull(workflowExecutions.terminationKind),
              exists(
                db
                  .select({ id: workflowWaitStates.id })
                  .from(workflowWaitStates)
                  .where(
                    and(
                      eq(workflowWaitStates.executionId, workflowExecutions.id),
                      eq(workflowWaitStates.status, "waiting")
                    )
                  )
              )
            )
          )
          .returning({ id: workflowExecutions.id });

        return parked.length > 0;
      }),

    endInFlight: (input) =>
      database.query(async (db) => {
        const now = new Date();
        const updated = await db
          .update(workflowExecutions)
          .set({
            status: input.status,
            waitingAt: null,
            cancelledAt: input.status === "canceled" ? now : null,
            completedAt: now,
            error: input.error,
          })
          .where(inFlightExecution(input.executionId))
          .returning({ id: workflowExecutions.id });

        const [state] = await db
          .select(TERMINATION_COLUMNS)
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.executionId))
          .limit(1);
        return state
          ? executionTerminationState(state, updated.length > 0)
          : null;
      }),

    requestCancelForEntity: (input) =>
      database.query(async (db) => {
        const requestedAt = new Date();
        const entityPredicate =
          input.entityType === undefined
            ? eq(workflowExecutions.entityValue, input.entityValue)
            : and(
                eq(workflowExecutions.entityType, input.entityType),
                eq(workflowExecutions.entityId, input.entityId)
              );
        const flagged = await db
          .update(workflowExecutions)
          .set({
            terminationKind: "cancel",
            terminationRequestedAt: requestedAt,
            cancelEventName: input.eventName,
            cancelPayload: input.payload,
          })
          .where(
            and(
              eq(workflowExecutions.workflowId, input.workflowId),
              entityPredicate,
              eq(workflowExecutions.runMode, input.runMode),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              // The first boundary claim owns the run. A second Cancel Event or
              // a concurrent exit cannot replace its kind or payload.
              isNull(workflowExecutions.terminationKind)
            )
          )
          .returning({ id: workflowExecutions.id });

        return flagged.map((row) => row.id);
      }),

    requestExit: (input) =>
      database.query(async (db) => {
        const updated = await db
          .update(workflowExecutions)
          .set({
            terminationKind: "exit",
            terminationRequestedAt: new Date(),
            terminationReason: input.reason,
            terminationNodeId: input.nodeId,
          })
          .where(inFlightExecution(input.executionId))
          .returning({ id: workflowExecutions.id });

        const [state] = await db
          .select(TERMINATION_COLUMNS)
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.executionId))
          .limit(1);
        return state
          ? executionTerminationState(state, updated.length > 0)
          : null;
      }),

    findTerminationState: (executionId) =>
      database.query(async (db) => {
        const [state] = await db
          .select(TERMINATION_COLUMNS)
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);
        return state ? executionTerminationState(state) : null;
      }),

    findPendingCancel: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: {
            terminationKind: true,
            cancelEventName: true,
            cancelPayload: true,
          },
        });

        if (execution?.terminationKind !== "cancel") {
          return null;
        }

        return {
          eventName: execution.cancelEventName,
          payload: execution.cancelPayload,
        };
      }),

    finishRun: (input) =>
      database.query(async (db) => {
        const claimGuard =
          input.status === "canceled"
            ? eq(workflowExecutions.terminationKind, "cancel")
            : input.status === "exited"
              ? eq(workflowExecutions.terminationKind, "exit")
              : isNull(workflowExecutions.terminationKind);
        const updated = await db
          .update(workflowExecutions)
          .set({
            status: input.status,
            output: input.output,
            error: input.error,
            waitingAt: null,
            cancelledAt: input.status === "canceled" ? new Date() : null,
            completedAt: new Date(),
            // Derived here rather than passed in, because the caller's clock is
            // the workflow function body, which a durable runtime re-runs on
            // every attempt and after every wait. The row holds when it started,
            // so both ends of the elapsed come from the same place.
            duration: sql`round(extract(epoch from ((now() at time zone 'utc') - ${workflowExecutions.startedAt})) * 1000)::text`,
          })
          .where(
            and(
              eq(workflowExecutions.id, input.executionId),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              claimGuard
            )
          )
          .returning({ id: workflowExecutions.id });

        const [state] = await db
          .select(TERMINATION_COLUMNS)
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, input.executionId))
          .limit(1);
        return state
          ? executionTerminationState(state, updated.length > 0)
          : null;
      }),
  };
}
