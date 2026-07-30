import {
  and,
  count,
  desc,
  eq,
  inArray,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "#src/backend/lib/workflow-audit";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { RovaDatabase, RovaTransaction } from "#src/backend/lib/db/index";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import type { JsonObject } from "@rova/shared/types/json";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@rova/shared/workflow/execution-contracts";
import type { Concurrency } from "@rova/shared/workflow/lifecycle-rules";

/** One row of `workflow_executions`, as the run panel and the engine see it. */
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;

/** One row of `workflow_execution_logs`, one node's attempt within a run. */
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;

/** One row of `workflow_execution_events`, the audit trail beside a run. */
export type WorkflowExecutionEvent =
  typeof workflowExecutionEvents.$inferSelect;

/** One row of `workflow_wait_states`, a node parked waiting to be woken. */
export type WorkflowWaitState = typeof workflowWaitStates.$inferSelect;

/**
 * The columns every entrypoint fills when it opens a run.
 *
 * Status is not among them: which status a new row gets follows from which
 * method is called, so `startForEntity` writes "running" itself rather than
 * trusting a caller to pass it.
 */
export type NewExecution = {
  workflowId: string;
  startSource: NonNullable<WorkflowExecution["startSource"]>;
  runMode: WorkflowExecution["runMode"];
  triggerEventType?: string;
  correlationKey?: string;
  input: JsonObject;
};

/**
 * A run that reached its verdict without executing the graph. It starts and
 * completes at the same instant, which is what keeps it visible in the runs
 * list beside runs that did execute.
 *
 * Its status is the caller's to choose, from the three a run can be in when it
 * never executed.
 */
export type NewTerminalExecution = NewExecution & {
  status: Extract<
    WorkflowExecution["status"],
    "completed" | "failed" | "canceled"
  >;
  output?: Record<string, unknown>;
  error?: string;
};

/** A run without the columns that say how it was triggered. */
export type ExecutionSummary = Pick<
  WorkflowExecution,
  | "id"
  | "workflowId"
  | "status"
  | "input"
  | "output"
  | "error"
  | "startedAt"
  | "completedAt"
  | "duration"
>;

/** A run reduced to where it got to. */
export type ExecutionStatusRow = Pick<WorkflowExecution, "id" | "status">;

/**
 * An execution carrying the two columns of its workflow the cross-workflow runs
 * list shows beside it, which is what the join in `listPage` is for.
 */
export type GlobalExecutionRow = WorkflowExecution & {
  workflowName: string;
  workflowIsPaused: boolean;
};

/**
 * What Concurrency did when a start asked for room, and the row it opened.
 *
 * `refused` names the runs it deferred to, so first-wins can say what it deferred
 * to rather than only that it declined.
 */
export type EntityStartOutcome =
  | {
      status: "started";
      execution: WorkflowExecution;
      /** Runs this start displaced, already `superseded` in the same transaction. */
      supersededExecutionIds: string[];
    }
  | { status: "refused"; inFlightExecutionIds: string[] };

/** Where a page of the cross-workflow runs list resumes from. */
export type ExecutionCursor = {
  startedAt: Date;
  id: string;
};

/** How the runs list narrows what it asks for. */
export type ExecutionPageQuery = {
  workflowIds?: string[];
  statuses?: WorkflowExecution["status"][];
  cursor?: ExecutionCursor;
  limit: number;
};

/**
 * Every database question the workflow services ask about runs: the executions
 * themselves, the per-node logs beside them, and the audit events.
 *
 * Separate from `WorkflowRepo` because these are a different aggregate with a
 * different lifetime: a workflow is edited, its runs accumulate and are swept.
 * The four polling endpoints the editor keeps open ask only through here.
 */
export class ExecutionRepo extends Context.Service<
  ExecutionRepo,
  {
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
    }) => Effect.Effect<WorkflowExecution[], DatabaseError>;
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
    /** One run without its routing columns, which is what the logs view shows. */
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
    /**
     * Open a run, with Concurrency applied to the entity it is about.
     *
     * One transaction holding an advisory lock on the workflow and Entity Value,
     * because the candidate read and the insert have to be one decision: two
     * reschedules arriving together otherwise both read an empty in-flight set
     * and both start, which the compare-and-set on the displaced rows cannot
     * catch. `unlimited` compares nothing, so it takes no lock and inserts
     * straight away.
     *
     * The Inngest sends stay outside: this answers what the rows now say, and the
     * caller tells the bus about it.
     */
    readonly startForEntity: (input: {
      execution: NewExecution;
      concurrency: Concurrency;
      /** Absent for a start with nothing to serialize on. */
      entityValue?: string;
      /** Written onto a displaced run's `error`, which run history shows. */
      supersededReason: string;
    }) => Effect.Effect<EntityStartOutcome, DatabaseError>;
    /** Record a run that never started, already in its terminal status. */
    readonly insertTerminal: (
      input: NewTerminalExecution
    ) => Effect.Effect<WorkflowExecution, DatabaseError>;
    /** Attach the Inngest event id once the enqueue has answered with one. */
    readonly setRunId: (input: {
      executionId: string;
      runId: string | null;
    }) => Effect.Effect<void, DatabaseError>;
    /**
     * Close a run whose enqueue was refused, answering whether a row was
     * written. Without it the row sits in "running" with nothing behind it that
     * could ever finish it.
     *
     * A rejected send is ambiguous: Inngest may have accepted the event and
     * failed on the way back, in which case the run is already executing. The
     * in-flight guard is what makes the ambiguity safe, since the compensation
     * can then only touch a run that has not reached a verdict, and a `false`
     * answer means the run got there first. The event carries an idempotency
     * key, so retrying a send later stays free whenever we decide to.
     */
    readonly markEnqueueFailed: (input: {
      executionId: string;
      error: string;
    }) => Effect.Effect<boolean, DatabaseError>;
    /**
     * The waiting node one resume token addresses, or null when the token names
     * no wait or one that has already moved on. Status is part of the question
     * rather than of the answer, since a resumed wait and an absent one are the
     * same "no longer active" to the caller.
     */
    readonly findWaitingStateByToken: (
      resumeToken: string
    ) => Effect.Effect<WorkflowWaitState | null, DatabaseError>;
    /** Every wait one run is currently parked on, for the runs panel. */
    readonly listWaitingStates: (
      executionId: string
    ) => Effect.Effect<WorkflowWaitState[], DatabaseError>;
    /** One run's node logs, newest first, whole rows. */
    readonly listLogs: (
      executionId: string
    ) => Effect.Effect<WorkflowExecutionLog[], DatabaseError>;
    /**
     * The same logs reduced to what the status poll reads. The two columns are
     * the point: the editor asks for this every two seconds while a run panel is
     * open, and the rows carry a node's whole input and output.
     */
    readonly listNodeStatuses: (
      executionId: string
    ) => Effect.Effect<
      Array<Pick<WorkflowExecutionLog, "nodeId" | "status">>,
      DatabaseError
    >;
    readonly listEvents: (
      executionId: string
    ) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
    /**
     * The Refused Starts: audit rows that belong to the workflow because no run
     * was opened for them. Nothing else can reach them, because every other
     * reader is keyed on an execution id and these have none.
     */
    readonly listWorkflowEvents: (
      workflowId: string
    ) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
    /**
     * Erase one workflow's run history, answering how many runs went. Logs, wait
     * states, and events go with them, which is why this is one method rather
     * than four: half a deletion leaves rows pointing at a run that is gone.
     */
    readonly deleteAllForWorkflow: (
      workflowId: string
    ) => Effect.Effect<number, DatabaseError>;
  }
>()("ExecutionRepo") {}

/** The most recent runs one workflow's panel shows. */
const WORKFLOW_EXECUTIONS_LIMIT = 50;

/** How far back the audit trail beside a single run is read. */
const EXECUTION_EVENTS_LIMIT = 200;

/**
 * How many Refused Starts the panel is given. Lower than the per-run limit above
 * because these are read for the whole workflow and a busy first-wins workflow
 * writes one per arrival it declines.
 */
const WORKFLOW_EVENTS_LIMIT = 50;

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

export const ExecutionRepoLayer: Layer.Layer<ExecutionRepo, never, Database> =
  Layer.effect(
    ExecutionRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      return {
        listByWorkflow: ({ workflowId, includeSuperseded }) =>
          database.query((db) =>
            db.query.workflowExecutions.findMany({
              // `and` drops an undefined member, so the toggle is one condition
              // that is there or is not.
              where: and(
                eq(workflowExecutions.workflowId, workflowId),
                includeSuperseded
                  ? undefined
                  : ne(workflowExecutions.status, "superseded")
              ),
              orderBy: [desc(workflowExecutions.startedAt)],
              limit: WORKFLOW_EXECUTIONS_LIMIT,
            })
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
                id: workflowExecutions.id,
                workflowId: workflowExecutions.workflowId,
                workflowName: workflows.name,
                workflowIsPaused: workflows.isPaused,
                status: workflowExecutions.status,
                startSource: workflowExecutions.startSource,
                runMode: workflowExecutions.runMode,
                triggerEventType: workflowExecutions.triggerEventType,
                correlationKey: workflowExecutions.correlationKey,
                workflowRunId: workflowExecutions.workflowRunId,
                input: workflowExecutions.input,
                output: workflowExecutions.output,
                error: workflowExecutions.error,
                startedAt: workflowExecutions.startedAt,
                waitingAt: workflowExecutions.waitingAt,
                cancelledAt: workflowExecutions.cancelledAt,
                completedAt: workflowExecutions.completedAt,
                duration: workflowExecutions.duration,
              })
              .from(workflowExecutions)
              .innerJoin(
                workflows,
                eq(workflowExecutions.workflowId, workflows.id)
              )
              .where(filters.length > 0 ? and(...filters) : undefined)
              .orderBy(
                desc(workflowExecutions.startedAt),
                desc(workflowExecutions.id)
              )
              .limit(query.limit);
          }),

        findSummaryById: (executionId) =>
          database.query(async (db) => {
            const execution = await db.query.workflowExecutions.findFirst({
              where: eq(workflowExecutions.id, executionId),
              columns: {
                id: true,
                workflowId: true,
                status: true,
                input: true,
                output: true,
                error: true,
                startedAt: true,
                completedAt: true,
                duration: true,
              },
            });

            return execution ?? null;
          }),

        findStatusById: (executionId) =>
          database.query(async (db) => {
            const execution = await db.query.workflowExecutions.findFirst({
              where: eq(workflowExecutions.id, executionId),
              columns: { id: true, status: true },
            });

            return execution ?? null;
          }),

        existsById: (executionId) =>
          database.query(async (db) => {
            const execution = await db.query.workflowExecutions.findFirst({
              where: eq(workflowExecutions.id, executionId),
              columns: { id: true },
            });

            return execution !== undefined;
          }),

        findWorkflowIdById: (executionId) =>
          database.query(async (db) => {
            const execution = await db.query.workflowExecutions.findFirst({
              where: eq(workflowExecutions.id, executionId),
              columns: { workflowId: true },
            });

            return execution?.workflowId ?? null;
          }),

        startForEntity: ({
          execution,
          concurrency,
          entityValue,
          supersededReason,
        }) =>
          database.query(async (db) => {
            const insertRunning = async (
              tx: RovaDatabase | RovaTransaction
            ) => {
              const [row] = await tx
                .insert(workflowExecutions)
                .values({
                  workflowId: execution.workflowId,
                  status: "running",
                  startSource: execution.startSource,
                  runMode: execution.runMode,
                  triggerEventType: execution.triggerEventType,
                  correlationKey: execution.correlationKey,
                  input: execution.input,
                })
                .returning();

              return row;
            };

            if (concurrency === "unlimited" || !entityValue) {
              return {
                status: "started" as const,
                execution: await insertRunning(db),
                supersededExecutionIds: [],
              };
            }

            return await db.transaction(async (tx) => {
              // Serialized per workflow and entity, and only against other
              // starts: nothing else in Rova takes a lock in this name space, so a
              // run's own writes never wait here. The two-key form keeps the
              // workflow and the entity in separate hashes, so no pair of values
              // can join into another pair's key. Two entities whose hashes
              // collide serialize against each other, which costs a wait and
              // decides nothing.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${`rova:entity:${execution.workflowId}`}), hashtext(${entityValue}))`
              );

              const inFlight = await tx
                .select({ id: workflowExecutions.id })
                .from(workflowExecutions)
                .where(
                  and(
                    eq(workflowExecutions.workflowId, execution.workflowId),
                    eq(workflowExecutions.correlationKey, entityValue),
                    eq(workflowExecutions.runMode, execution.runMode),
                    inArray(workflowExecutions.status, [
                      ...IN_FLIGHT_EXECUTION_STATUSES,
                    ])
                  )
                );

              if (inFlight.length > 0 && concurrency === "first-wins") {
                return {
                  status: "refused" as const,
                  inFlightExecutionIds: inFlight.map((row) => row.id),
                };
              }

              let supersededExecutionIds: string[] = [];

              if (inFlight.length > 0) {
                const ids = inFlight.map((row) => row.id);
                const now = new Date();

                const superseded = await tx
                  .update(workflowExecutions)
                  .set({
                    status: "superseded",
                    waitingAt: null,
                    completedAt: now,
                    error: supersededReason,
                  })
                  .where(
                    and(
                      inArray(workflowExecutions.id, ids),
                      inArray(workflowExecutions.status, [
                        ...IN_FLIGHT_EXECUTION_STATUSES,
                      ])
                    )
                  )
                  .returning({ id: workflowExecutions.id });

                supersededExecutionIds = superseded.map((row) => row.id);

                if (supersededExecutionIds.length > 0) {
                  await tx
                    .update(workflowWaitStates)
                    .set({ status: "cancelled", cancelledAt: now })
                    .where(
                      and(
                        inArray(
                          workflowWaitStates.executionId,
                          supersededExecutionIds
                        ),
                        eq(workflowWaitStates.status, "waiting")
                      )
                    );
                }
              }

              return {
                status: "started" as const,
                execution: await insertRunning(tx),
                supersededExecutionIds,
              };
            });
          }),

        insertTerminal: (input) =>
          database.query(async (db) => {
            const now = new Date();
            const [execution] = await db
              .insert(workflowExecutions)
              .values({
                workflowId: input.workflowId,
                status: input.status,
                startSource: input.startSource,
                runMode: input.runMode,
                triggerEventType: input.triggerEventType,
                correlationKey: input.correlationKey,
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

        setRunId: (input) =>
          database.query(async (db) => {
            await db
              .update(workflowExecutions)
              .set({ workflowRunId: input.runId })
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

        findWaitingStateByToken: (resumeToken) =>
          database.query(async (db) => {
            const waitState = await db.query.workflowWaitStates.findFirst({
              where: and(
                eq(workflowWaitStates.resumeToken, resumeToken),
                eq(workflowWaitStates.status, "waiting")
              ),
            });

            return waitState ?? null;
          }),

        listWaitingStates: (executionId) =>
          database.query((db) =>
            db.query.workflowWaitStates.findMany({
              where: and(
                eq(workflowWaitStates.executionId, executionId),
                eq(workflowWaitStates.status, "waiting")
              ),
            })
          ),

        listLogs: (executionId) =>
          database.query((db) =>
            db.query.workflowExecutionLogs.findMany({
              where: eq(workflowExecutionLogs.executionId, executionId),
              orderBy: [desc(workflowExecutionLogs.timestamp)],
            })
          ),

        listNodeStatuses: (executionId) =>
          database.query((db) =>
            db.query.workflowExecutionLogs.findMany({
              where: eq(workflowExecutionLogs.executionId, executionId),
              columns: { nodeId: true, status: true },
            })
          ),

        listEvents: (executionId) =>
          database.query((db) =>
            db.query.workflowExecutionEvents.findMany({
              where: eq(workflowExecutionEvents.executionId, executionId),
              orderBy: [desc(workflowExecutionEvents.createdAt)],
              limit: EXECUTION_EVENTS_LIMIT,
            })
          ),

        listWorkflowEvents: (workflowId) =>
          database.query((db) =>
            db.query.workflowExecutionEvents.findMany({
              // By type rather than by the absent execution id: the scope is what
              // the type means, and a row is unreadable anywhere else because of
              // it. A null id is the consequence, not the definition.
              where: and(
                eq(workflowExecutionEvents.workflowId, workflowId),
                inArray(workflowExecutionEvents.eventType, [
                  ...WORKFLOW_SCOPED_AUDIT_EVENT_TYPES,
                ])
              ),
              orderBy: [desc(workflowExecutionEvents.createdAt)],
              limit: WORKFLOW_EVENTS_LIMIT,
            })
          ),

        deleteAllForWorkflow: (workflowId) =>
          database.query(async (db) => {
            const executions = await db.query.workflowExecutions.findMany({
              where: eq(workflowExecutions.workflowId, workflowId),
              columns: { id: true },
            });

            const executionIds = executions.map((execution) => execution.id);

            // One transaction, because the deletes only make sense together: a
            // failure between them would leave logs, wait states, or audit rows
            // pointing at a run that is gone.
            //
            // The audit rows go by workflow rather than by run, which is what
            // makes "all runs deleted" true: a Refused Start has no run to be
            // found through, and a workflow with nothing but refusals has an
            // empty execution list and history to clear all the same.
            await db.transaction(async (tx) => {
              if (executionIds.length > 0) {
                await tx
                  .delete(workflowExecutionLogs)
                  .where(
                    inArray(workflowExecutionLogs.executionId, executionIds)
                  );

                await tx
                  .delete(workflowWaitStates)
                  .where(inArray(workflowWaitStates.executionId, executionIds));
              }

              await tx
                .delete(workflowExecutionEvents)
                .where(eq(workflowExecutionEvents.workflowId, workflowId));

              await tx
                .delete(workflowExecutions)
                .where(eq(workflowExecutions.workflowId, workflowId));
            });

            return executionIds.length;
          }),
      };
    })
  );
