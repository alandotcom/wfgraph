import {
  and,
  count,
  desc,
  eq,
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
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";
import type {
  ExecutionPageQuery,
  ExecutionStatusRow,
  ExecutionSummary,
  GlobalExecutionRow,
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
    inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
  );
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
   * Move a run back from "waiting" to "running", answering whether a waiting
   * row was there to move.
   */
  readonly markRunning: (
    executionId: string
  ) => Effect.Effect<boolean, DatabaseError>;
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
    error?: string;
  }) => Effect.Effect<boolean, DatabaseError>;
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
  readonly requestCancelForEntity: (input: {
    workflowId: string;
    entityValue: string;
    runMode: WorkflowExecution["runMode"];
    eventName: string;
    payload: JsonObject;
  }) => Effect.Effect<string[], DatabaseError>;
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
    status: "completed" | "failed" | "canceled";
    output?: JsonValue;
    error?: string;
  }) => Effect.Effect<boolean, DatabaseError>;
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
              ])
            )
          )
          .returning({ id: workflowExecutions.id });

        return closed.length > 0;
      }),

    markRunning: (executionId) =>
      database.query(async (db) => {
        const moved = await db
          .update(workflowExecutions)
          .set({ status: "running", waitingAt: null })
          .where(
            and(
              eq(workflowExecutions.id, executionId),
              eq(workflowExecutions.status, "waiting")
            )
          )
          .returning({ id: workflowExecutions.id });

        return moved.length > 0;
      }),

    endInFlight: (input) =>
      database.query(async (db) => {
        const now = new Date();
        const ended = await db
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

        return ended.length > 0;
      }),

    requestCancelForEntity: (input) =>
      database.query(async (db) => {
        const flagged = await db
          .update(workflowExecutions)
          .set({
            cancelRequestedAt: new Date(),
            cancelEventName: input.eventName,
            cancelPayload: input.payload,
          })
          .where(
            and(
              eq(workflowExecutions.workflowId, input.workflowId),
              eq(workflowExecutions.entityValue, input.entityValue),
              eq(workflowExecutions.runMode, input.runMode),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              // First cancel wins, held on the statement: a second Cancel Event
              // for the same entity would otherwise overwrite the payload the
              // Canceled branch is already running against.
              isNull(workflowExecutions.cancelRequestedAt)
            )
          )
          .returning({ id: workflowExecutions.id });

        return flagged.map((row) => row.id);
      }),

    findPendingCancel: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: {
            cancelRequestedAt: true,
            cancelEventName: true,
            cancelPayload: true,
          },
        });

        if (!execution?.cancelRequestedAt) {
          return null;
        }

        return {
          eventName: execution.cancelEventName,
          payload: execution.cancelPayload,
        };
      }),

    finishRun: (input) =>
      database.query(async (db) => {
        const finished = await db
          .update(workflowExecutions)
          .set({
            status: input.status,
            output: input.output,
            error: input.error,
            waitingAt: null,
            completedAt: new Date(),
            // Derived here rather than passed in, because the caller's clock is
            // the workflow function body, which a durable runtime re-runs on
            // every attempt and after every wait. The row holds when it started,
            // so both ends of the elapsed come from the same place.
            duration: sql`round(extract(epoch from ((now() at time zone 'utc') - ${workflowExecutions.startedAt})) * 1000)::text`,
          })
          .where(inFlightExecution(input.executionId))
          .returning({ id: workflowExecutions.id });

        return finished.length > 0;
      }),
  };
}
