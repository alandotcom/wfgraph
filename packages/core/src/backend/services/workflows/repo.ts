import { and, desc, eq, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  type Workflow,
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import type { WorkflowUpdateData } from "#src/backend/services/workflows/workflow-mappers";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

/** One row of `workflow_executions`, as the run panel and the engine see it. */
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;

/** One row of `workflow_execution_logs`, one node's attempt within a run. */
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;

/** One row of `workflow_execution_events`, the audit trail beside a run. */
export type WorkflowExecutionEvent =
  typeof workflowExecutionEvents.$inferSelect;

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
 * Every database question the workflow services ask about workflows themselves.
 *
 * The domain code above it never names a table or a column, which is what lets a
 * test answer these directly instead of standing up a database, and a query
 * failure arrives as a typed `DatabaseError` rather than a rejected promise, the
 * way ADR-0005 describes.
 *
 * These write their own Drizzle against the handle the `Database` service owns,
 * as the API key repository does, because no `backend/lib/db` module holds the
 * workflow queries.
 */
export class WorkflowRepo extends Context.Service<
  WorkflowRepo,
  {
    /** Most recently updated first, which is the order the list screen shows. */
    readonly listNewestFirst: () => Effect.Effect<Workflow[], DatabaseError>;
    readonly findById: (
      workflowId: string
    ) => Effect.Effect<Workflow | null, DatabaseError>;
    /**
     * Whether the workflow is there at all. Separate from `findById` because the
     * paths that only need to answer "not found" have no use for a graph column
     * that can run to megabytes.
     */
    readonly existsById: (
      workflowId: string
    ) => Effect.Effect<boolean, DatabaseError>;
    /**
     * Whether another workflow already holds this name, compared the way the
     * unique index does, which is case-insensitively.
     */
    readonly hasOtherWithName: (input: {
      name: string;
      excludingWorkflowId: string;
    }) => Effect.Effect<boolean, DatabaseError>;
    /** Null when the row was gone by the time the update ran. */
    readonly update: (
      workflowId: string,
      updates: WorkflowUpdateData
    ) => Effect.Effect<Workflow | null, DatabaseError>;
    readonly deleteById: (
      workflowId: string
    ) => Effect.Effect<void, DatabaseError>;
    /**
     * The single workflow the editor autosaves into, newest first because the
     * name is only unique through an index the autosave path predates.
     */
    readonly findCurrent: () => Effect.Effect<Workflow | null, DatabaseError>;
    readonly insertCurrent: (input: {
      id: string;
      graph: SerializedWorkflowGraph;
    }) => Effect.Effect<Workflow | null, DatabaseError>;
  }
>()("WorkflowRepo") {}

export const WorkflowRepoLayer: Layer.Layer<WorkflowRepo, never, Database> =
  Layer.effect(
    WorkflowRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      const findCurrent = () =>
        database.query(async (db) => {
          const [currentWorkflow] = await db
            .select()
            .from(workflows)
            .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
            .orderBy(desc(workflows.updatedAt))
            .limit(1);

          return currentWorkflow ?? null;
        });

      return {
        listNewestFirst: () =>
          database.query((db) =>
            db.select().from(workflows).orderBy(desc(workflows.updatedAt))
          ),

        findById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
            });

            return workflow ?? null;
          }),

        existsById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
              columns: { id: true },
            });

            return workflow !== undefined;
          }),

        hasOtherWithName: (input) =>
          database.query(async (db) => {
            const conflict = await db.query.workflows.findFirst({
              where: and(
                sql`lower(${workflows.name}) = lower(${input.name})`,
                ne(workflows.id, input.excludingWorkflowId)
              ),
              columns: { id: true },
            });

            return conflict !== undefined;
          }),

        update: (workflowId, updates) =>
          database.query(async (db) => {
            const updated = await db
              .update(workflows)
              .set(updates)
              .where(eq(workflows.id, workflowId))
              .returning();

            return updated.at(0) ?? null;
          }),

        deleteById: (workflowId) =>
          database.query(async (db) => {
            await db.delete(workflows).where(eq(workflows.id, workflowId));
          }),

        findCurrent,

        insertCurrent: (input) =>
          database.query(async (db) => {
            const saved = await db
              .insert(workflows)
              .values({
                id: input.id,
                name: CURRENT_WORKFLOW_NAME,
                description: "Auto-saved current workflow",
                graph: input.graph,
              })
              .returning();

            return saved.at(0) ?? null;
          }),
      };
    })
  );

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
    /** One workflow's most recent runs, newest first. */
    readonly listByWorkflow: (
      workflowId: string
    ) => Effect.Effect<WorkflowExecution[], DatabaseError>;
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
        listByWorkflow: (workflowId) =>
          database.query((db) =>
            db.query.workflowExecutions.findMany({
              where: eq(workflowExecutions.workflowId, workflowId),
              orderBy: [desc(workflowExecutions.startedAt)],
              limit: WORKFLOW_EXECUTIONS_LIMIT,
            })
          ),

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
                triggerType: workflowExecutions.triggerType,
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

        deleteAllForWorkflow: (workflowId) =>
          database.query(async (db) => {
            const executions = await db.query.workflowExecutions.findMany({
              where: eq(workflowExecutions.workflowId, workflowId),
              columns: { id: true },
            });

            const executionIds = executions.map((execution) => execution.id);
            if (executionIds.length === 0) {
              return 0;
            }

            // One transaction, because the four deletes only make sense
            // together: a failure between them would leave logs, wait states,
            // or events pointing at a run that is gone.
            await db.transaction(async (tx) => {
              await tx
                .delete(workflowExecutionLogs)
                .where(
                  inArray(workflowExecutionLogs.executionId, executionIds)
                );

              await tx
                .delete(workflowWaitStates)
                .where(inArray(workflowWaitStates.executionId, executionIds));

              await tx
                .delete(workflowExecutionEvents)
                .where(
                  inArray(workflowExecutionEvents.executionId, executionIds)
                );

              await tx
                .delete(workflowExecutions)
                .where(eq(workflowExecutions.workflowId, workflowId));
            });

            return executionIds.length;
          }),
      };
    })
  );
