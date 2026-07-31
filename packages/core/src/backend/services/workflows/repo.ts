import { and, arrayContains, desc, eq, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  type Workflow,
  workflowEventSubscriptions,
  type WorkflowMode,
  type WorkflowVisibility,
  workflows,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import type { WorkflowUpdateData } from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

/** One row of `workflow_event_subscriptions`: one workflow, one Event, one role. */
export type WorkflowEventSubscriptionRow =
  typeof workflowEventSubscriptions.$inferSelect;

/** Every column of `workflows` but the graph. */
const workflowSummaryColumns = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  isPaused: workflows.isPaused,
  mode: workflows.mode,
  visibility: workflows.visibility,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
};

export type WorkflowSummaryRow = Omit<Workflow, "graph">;

/**
 * A workflow one delivered Event concerns, and what it holds that Event for.
 *
 * The roles decide how much work the delivery is worth: a `start` runs the full
 * preflight, and a workflow holding only `wait` needs none of it. The name and
 * mode ride along because the join reads them anyway, which is what keeps a
 * wait-only delivery off the graph column.
 */
export type EventSubscriber = {
  id: string;
  name: string;
  mode: WorkflowMode;
  roles: WorkflowEventSubscriptionRow["role"][];
  /**
   * Where this workflow reads the Event's Entity Value when the Event declares no
   * Correlation Path of its own. Null when neither declares one, which is a
   * workflow that cannot identify entities for this Event at all.
   */
  correlationPath: string | null;
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
    /**
     * Most recently updated first, which is the order the list screen shows,
     * and without the graph column: the dashboard table and the toolbar's
     * switcher both draw names, and reading whole rows here would pull every
     * stored graph into memory on every `refreshWorkflowList`.
     */
    readonly listSummariesNewestFirst: () => Effect.Effect<
      WorkflowSummaryRow[],
      DatabaseError
    >;
    /**
     * Every workflow's id and name, and nothing else.
     *
     * What the Inngest function registry builds its run handlers from: one
     * function per workflow, keyed on the id and labelled with the name. Reading
     * whole rows there would pull every stored graph into memory on a cache miss.
     */
    readonly listIdentities: () => Effect.Effect<
      Array<Pick<Workflow, "id" | "name">>,
      DatabaseError
    >;
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
     * Whether any workflow already holds this name, compared the way the unique
     * index does, which is case-insensitively.
     */
    readonly hasWithName: (
      name: string
    ) => Effect.Effect<boolean, DatabaseError>;
    /** The same question asked from a workflow that may legally hold the name. */
    readonly hasOtherWithName: (input: {
      name: string;
      excludingWorkflowId: string;
    }) => Effect.Effect<boolean, DatabaseError>;
    /**
     * The workflows a delivered Event concerns.
     *
     * Two reads, unioned, because the Event reaches a workflow for two unrelated
     * reasons. The derived index answers which workflows name this Event in the
     * graph they hold now, which is what a start needs. The parked-run read answers
     * which runs are still waiting on it, and it asks each row's own
     * `subscribed_events`, written when the run parked: a Wait node edited since
     * then no longer describes what its parked runs are owed, and the run would
     * otherwise wait out its timeout. Both are indexed on the Event name.
     *
     * Paused workflows are left out here rather than skipped later: a paused
     * workflow starts nothing and its parked runs are not reachable either, and
     * filtering in the join is what keeps a per-delivery row out of the timeline.
     */
    readonly listEventSubscribers: (
      eventName: string
    ) => Effect.Effect<EventSubscriber[], DatabaseError>;
    /**
     * Store a new workflow. `mode` and `visibility` are left to their column
     * defaults unless a caller carries them over from a source workflow, which
     * duplication does and creation does not.
     *
     * `eventSubscriptions` are the rows this graph calls for, written in the same
     * transaction: a graph and the index over it are one fact.
     */
    readonly insert: (input: {
      id: string;
      name: string;
      description?: string | null;
      graph: SerializedWorkflowGraph;
      mode?: WorkflowMode;
      visibility?: WorkflowVisibility;
      isPaused?: boolean;
      eventSubscriptions: WorkflowEventSubscriptionRow[];
    }) => Effect.Effect<Workflow, DatabaseError>;
    /**
     * Whether the workflow is paused, or null when it is gone. The bulk
     * lifecycle path reads this before writing so that a pause that changes
     * nothing costs no update.
     */
    readonly findPausedById: (
      workflowId: string
    ) => Effect.Effect<{ id: string; isPaused: boolean } | null, DatabaseError>;
    readonly setPaused: (input: {
      workflowId: string;
      isPaused: boolean;
    }) => Effect.Effect<void, DatabaseError>;
    /**
     * Null when the row was gone by the time the update ran.
     *
     * `eventSubscriptions` replaces this workflow's rows wholesale, and saying so
     * is not optional: a graph write that forgot the index derived from it would
     * leave a workflow subscribed to the Events of a graph it no longer has.
     * `"unchanged"` is the other half of that -- a rename touches no graph, and
     * re-deriving would mean re-validating a stored graph a rename has no business
     * refusing.
     */
    readonly update: (input: {
      workflowId: string;
      updates: WorkflowUpdateData;
      eventSubscriptions: WorkflowEventSubscriptionRow[] | "unchanged";
    }) => Effect.Effect<Workflow | null, DatabaseError>;
    readonly deleteById: (
      workflowId: string
    ) => Effect.Effect<void, DatabaseError>;
    /**
     * The single workflow the editor autosaves into, newest first because the
     * name is only unique through an index the autosave path predates.
     */
    readonly findCurrent: () => Effect.Effect<Workflow | null, DatabaseError>;
    /**
     * The draft subscribes to nothing: an Event may not start a run of a graph
     * nobody has saved, so no subscription rows are written for it here or on
     * the updates that follow.
     */
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
        listSummariesNewestFirst: () =>
          database.query((db) =>
            db
              .select(workflowSummaryColumns)
              .from(workflows)
              .orderBy(desc(workflows.updatedAt))
          ),

        listIdentities: () =>
          database.query((db) =>
            db.query.workflows.findMany({ columns: { id: true, name: true } })
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

        hasWithName: (name) =>
          database.query(async (db) => {
            const conflict = await db.query.workflows.findFirst({
              where: sql`lower(${workflows.name}) = lower(${name})`,
              columns: { id: true },
            });

            return conflict !== undefined;
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

        listEventSubscribers: (eventName) =>
          database.query(async (db) => {
            const [named, parked] = await Promise.all([
              // The wait role is left to the parked read: a graph naming an Event
              // on a Wait node with nothing parked on it is owed no delivery, and
              // a row here would buy a durable step that resolves to zero runs.
              // `cancel` rides along so the Canceled outlet needs no change here.
              db
                .select({
                  id: workflows.id,
                  name: workflows.name,
                  mode: workflows.mode,
                  role: workflowEventSubscriptions.role,
                  correlationPath: workflowEventSubscriptions.correlationPath,
                })
                .from(workflowEventSubscriptions)
                .innerJoin(
                  workflows,
                  eq(workflowEventSubscriptions.workflowId, workflows.id)
                )
                .where(
                  and(
                    eq(workflowEventSubscriptions.eventName, eventName),
                    ne(workflowEventSubscriptions.role, "wait"),
                    eq(workflows.isPaused, false)
                  )
                ),
              // A parked run holds the wait role whether or not the graph still
              // names the Event it parked on, so the join here is only for
              // `correlationPath`, by a left join rather than a second round
              // trip: an orphaned run's workflow may no longer carry that row at
              // all, and one held to the wait role specifically is what stops a
              // workflow's start or cancel row for the same Event from being the
              // one the planner happens to pick.
              db
                .selectDistinct({
                  id: workflows.id,
                  name: workflows.name,
                  mode: workflows.mode,
                  correlationPath: workflowEventSubscriptions.correlationPath,
                })
                .from(workflowWaitStates)
                .innerJoin(
                  workflows,
                  eq(workflowWaitStates.workflowId, workflows.id)
                )
                .leftJoin(
                  workflowEventSubscriptions,
                  and(
                    eq(workflowEventSubscriptions.workflowId, workflows.id),
                    eq(workflowEventSubscriptions.eventName, eventName),
                    eq(workflowEventSubscriptions.role, "wait")
                  )
                )
                .where(
                  and(
                    eq(workflowWaitStates.status, "waiting"),
                    arrayContains(workflowWaitStates.subscribedEvents, [
                      eventName,
                    ]),
                    eq(workflows.isPaused, false)
                  )
                ),
            ]);

            const byId = new Map<string, EventSubscriber>();

            for (const row of named) {
              const existing = byId.get(row.id);
              if (existing) {
                existing.roles.push(row.role);
                continue;
              }
              byId.set(row.id, {
                id: row.id,
                name: row.name,
                mode: row.mode,
                roles: [row.role],
                correlationPath: row.correlationPath,
              });
            }

            for (const row of parked) {
              const existing = byId.get(row.id);
              if (existing) {
                if (!existing.roles.includes("wait")) {
                  existing.roles.push("wait");
                }
                continue;
              }
              byId.set(row.id, {
                id: row.id,
                name: row.name,
                mode: row.mode,
                roles: ["wait"],
                correlationPath: row.correlationPath,
              });
            }

            return Array.from(byId.values());
          }),

        insert: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                const [inserted] = await tx
                  .insert(workflows)
                  .values({
                    id: input.id,
                    name: input.name,
                    description: input.description,
                    graph: input.graph,
                    mode: input.mode,
                    visibility: input.visibility,
                  })
                  .returning();

                if (input.eventSubscriptions.length > 0) {
                  await tx
                    .insert(workflowEventSubscriptions)
                    .values(input.eventSubscriptions);
                }

                return inserted;
              })
          ),

        findPausedById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
              columns: { id: true, isPaused: true },
            });

            return workflow ?? null;
          }),

        setPaused: (input) =>
          database.query(async (db) => {
            await db
              .update(workflows)
              .set({ isPaused: input.isPaused, updatedAt: new Date() })
              .where(eq(workflows.id, input.workflowId));
          }),

        update: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                const updated = await tx
                  .update(workflows)
                  .set(input.updates)
                  .where(eq(workflows.id, input.workflowId))
                  .returning();

                const workflow = updated.at(0);
                if (!workflow) {
                  return null;
                }

                const rows = input.eventSubscriptions;
                if (rows !== "unchanged") {
                  await tx
                    .delete(workflowEventSubscriptions)
                    .where(
                      eq(
                        workflowEventSubscriptions.workflowId,
                        input.workflowId
                      )
                    );

                  if (rows.length > 0) {
                    await tx.insert(workflowEventSubscriptions).values(rows);
                  }
                }

                return workflow;
              })
          ),

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
