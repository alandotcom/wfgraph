import {
  and,
  arrayContains,
  desc,
  eq,
  inArray,
  lte,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import {
  type Workflow,
  workflowExecutions,
  type WorkflowVersion,
  workflowEventSubscriptions,
  type WorkflowMode,
  type WorkflowVisibility,
  workflows,
  workflowVersions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { RovaDatabase, RovaTransaction } from "#src/backend/lib/db/index";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import type { WorkflowUpdateData } from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";

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
  publishedVersionId: workflows.publishedVersionId,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
};

export type WorkflowSummaryRow = Omit<Workflow, "graph">;

/** The columns a run reads off the workflow row: enough to gate and route it. */
const workflowRunColumns = {
  id: workflows.id,
  name: workflows.name,
  mode: workflows.mode,
  isPaused: workflows.isPaused,
};

export type WorkflowRunRow = Pick<
  Workflow,
  "id" | "name" | "mode" | "isPaused"
>;

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
   * The builder's own Correlation Path for this Event, which outranks the one the
   * Event declares. Null where they wrote none, leaving the declaration to stand.
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
    readonly listSummariesNewestFirst: Effect.Effect<
      WorkflowSummaryRow[],
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
    readonly findCurrent: Effect.Effect<Workflow | null, DatabaseError>;
    /**
     * The draft subscribes to nothing: an Event may not start a run of a graph
     * nobody has saved, so no subscription rows are written for it here or on
     * the updates that follow.
     */
    readonly insertCurrent: (input: {
      id: string;
      graph: SerializedWorkflowGraph;
    }) => Effect.Effect<Workflow | null, DatabaseError>;
    /** The newest published version for this workflow, or null when none exist. */
    readonly findLatestVersion: (
      workflowId: string
    ) => Effect.Effect<WorkflowVersion | null, DatabaseError>;
    /** One version by id, or null when it is gone. */
    readonly findVersionById: (
      versionId: string
    ) => Effect.Effect<WorkflowVersion | null, DatabaseError>;
    /**
     * A prior version whose content hash and catalog fingerprint match, newest
     * first. Used by publish to reuse rather than mint a duplicate row.
     */
    readonly findVersionByContent: (input: {
      workflowId: string;
      graphDigest: string;
      catalogFingerprint: string;
    }) => Effect.Effect<WorkflowVersion | null, DatabaseError>;
    /**
     * The version `published_version_id` names, or null when the workflow is
     * gone or has never been published.
     */
    readonly findPublishedVersion: (
      workflowId: string
    ) => Effect.Effect<WorkflowVersion | null, DatabaseError>;
    /**
     * The workflow and the version it currently points at, in one round trip.
     * `publishedVersion` is null when the workflow exists but has never been
     * published.
     */
    readonly findByIdWithPublishedVersion: (
      workflowId: string
    ) => Effect.Effect<
      { workflow: Workflow; publishedVersion: WorkflowVersion | null } | null,
      DatabaseError
    >;
    /**
     * The same pair as `findByIdWithPublishedVersion`, narrowed to what a run
     * reads off the workflow: `id`, `name`, `mode` and `isPaused`.
     *
     * The delivery fan-out and the manual-start preflight take this instead:
     * both gate and route a run off these four columns and never the draft
     * graph, which is what `findByIdWithPublishedVersion` still carries for the
     * editor's load. The published version rides along in full, since preflight
     * validates that graph.
     */
    readonly findByIdWithPublishedVersionForRun: (
      workflowId: string
    ) => Effect.Effect<
      {
        workflow: WorkflowRunRow;
        publishedVersion: WorkflowVersion | null;
      } | null,
      DatabaseError
    >;
    /**
     * Point the workflow at an existing version, align the draft graph, and
     * rewrite subscriptions, in one transaction.
     */
    readonly setPublishedVersion: (input: {
      workflowId: string;
      versionId: string;
      draftGraph: SerializedWorkflowGraph;
      eventSubscriptions: WorkflowEventSubscriptionRow[];
    }) => Effect.Effect<
      { workflow: Workflow; version: WorkflowVersion } | null,
      DatabaseError
    >;
    /**
     * Claim a new version number (optimistic: insert only if still free), then
     * point the workflow at it, align the draft, and rewrite subscriptions.
     * `{ stale: true }` means another publish already took that number.
     */
    readonly insertPublishedVersion: (input: {
      workflowId: string;
      versionId: string;
      version: number;
      graph: SerializedWorkflowGraph;
      catalogFingerprint: string;
      graphDigest: string;
      draftGraph: SerializedWorkflowGraph;
      eventSubscriptions: WorkflowEventSubscriptionRow[];
    }) => Effect.Effect<InsertPublishedVersionResult, DatabaseError>;
    /**
     * Delete this workflow's versions that nothing points at, keeping the
     * newest `keepNewest` whatever their state, and answer the ids that went.
     *
     * A version goes only when no execution pins it and no workflow names it as
     * published, because both foreign keys act destructively: the executions one
     * cascades and would take a run's whole history, `published_version_id` sets
     * null and would silently unpublish. Candidates are claimed with `for update
     * skip locked` — the one lock strength that conflicts with the `for key
     * share` an FK insert takes — and the predicate is then re-checked in the
     * delete, which is a second statement and so a second snapshot under READ
     * COMMITTED. That pair is what makes the answer final: a row another
     * transaction is part way through pinning is skipped, and a row pinned since
     * the claim fails the re-check. `limit` bounds one sweep, so a long backlog
     * drains over several rather than in one.
     */
    readonly pruneUnreferencedVersions: (input: {
      workflowId: string;
      keepNewest: number;
      limit: number;
    }) => Effect.Effect<string[], DatabaseError>;
  }
>()("@rova/core/WorkflowRepo") {}

/** Outcome of `insertPublishedVersion`: published, behind, or workflow missing. */
export type InsertPublishedVersionResult =
  | { workflow: Workflow; version: WorkflowVersion }
  | { stale: true }
  | null;

/**
 * The query behind `findByIdWithPublishedVersion` and its `ForRun` sibling:
 * same select, join, where and limit, and the same null check when the
 * workflow is gone. The two callers differ only in which `workflows` columns
 * they ask for, so that column set is the one parameter; a later change to
 * the join or the where clause (a soft-delete filter, say) then lands on
 * both callers by construction instead of needing two edits kept in sync
 * by hand.
 */
async function selectWorkflowWithPublishedVersion<
  WorkflowColumns extends Record<string, PgColumn> | PgTable,
>(db: RovaDatabase, workflowId: string, workflowColumns: WorkflowColumns) {
  const [row] = await db
    .select({
      workflow: workflowColumns,
      publishedVersion: workflowVersions,
    })
    .from(workflows)
    .leftJoin(
      workflowVersions,
      eq(workflows.publishedVersionId, workflowVersions.id)
    )
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    workflow: row.workflow,
    publishedVersion: row.publishedVersion,
  };
}

export const WorkflowRepoLayer: Layer.Layer<WorkflowRepo, never, Database> =
  Layer.effect(
    WorkflowRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      const findCurrent = database.query(async (db) => {
        const [currentWorkflow] = await db
          .select()
          .from(workflows)
          .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
          .orderBy(desc(workflows.updatedAt))
          .limit(1);

        return currentWorkflow ?? null;
      });

      return {
        listSummariesNewestFirst: database.query((db) =>
          db
            .select(workflowSummaryColumns)
            .from(workflows)
            .orderBy(desc(workflows.updatedAt))
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
                    isPaused: input.isPaused,
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

        findLatestVersion: (workflowId) =>
          database.query(async (db) => {
            const [row] = await db
              .select()
              .from(workflowVersions)
              .where(eq(workflowVersions.workflowId, workflowId))
              .orderBy(desc(workflowVersions.version))
              .limit(1);

            return row ?? null;
          }),

        findVersionById: (versionId) =>
          database.query(async (db) => {
            const row = await db.query.workflowVersions.findFirst({
              where: eq(workflowVersions.id, versionId),
            });

            return row ?? null;
          }),

        findVersionByContent: (input) =>
          database.query(async (db) => {
            const [row] = await db
              .select()
              .from(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.workflowId, input.workflowId),
                  eq(workflowVersions.graphDigest, input.graphDigest),
                  eq(
                    workflowVersions.catalogFingerprint,
                    input.catalogFingerprint
                  )
                )
              )
              .orderBy(desc(workflowVersions.version))
              .limit(1);

            return row ?? null;
          }),

        findPublishedVersion: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: eq(workflows.id, workflowId),
              columns: { publishedVersionId: true },
            });
            if (!workflow?.publishedVersionId) {
              return null;
            }

            const row = await db.query.workflowVersions.findFirst({
              where: eq(workflowVersions.id, workflow.publishedVersionId),
            });

            return row ?? null;
          }),

        findByIdWithPublishedVersion: (workflowId) =>
          database.query((db) =>
            selectWorkflowWithPublishedVersion(db, workflowId, workflows)
          ),

        findByIdWithPublishedVersionForRun: (workflowId) =>
          database.query((db) =>
            selectWorkflowWithPublishedVersion(
              db,
              workflowId,
              workflowRunColumns
            )
          ),

        setPublishedVersion: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                // `for key share` against the version sweep, which claims a
                // prunable row `for update`. Publish reaches this path by
                // content dedupe, which can name a version old enough to be a
                // sweep candidate; a plain snapshot read would let the sweep
                // delete it between this read and the update below, and the
                // update would then fail the foreign key. Whichever lock lands
                // first now decides: the sweep skips a row held here, and a read
                // held behind the sweep sees the row gone and answers null.
                const [version] = await tx
                  .select()
                  .from(workflowVersions)
                  .where(eq(workflowVersions.id, input.versionId))
                  .limit(1)
                  .for("key share");
                if (!version) {
                  return null;
                }
                return activatePublishedVersion(tx, {
                  workflowId: input.workflowId,
                  version,
                  draftGraph: input.draftGraph,
                  eventSubscriptions: input.eventSubscriptions,
                });
              })
          ),

        insertPublishedVersion: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                // Verify before minting: a soft null after the insert would
                // commit an orphan version row. Presence here means the later
                // update cannot miss under the FK KEY SHARE the insert takes.
                const existing = await tx.query.workflows.findFirst({
                  where: eq(workflows.id, input.workflowId),
                  columns: { id: true },
                });
                if (!existing) {
                  return null;
                }

                // Optimistic claim: insert only if `version` is still free.
                // Empty returning means another publish took it.
                const [minted] = await tx
                  .insert(workflowVersions)
                  .values({
                    id: input.versionId,
                    workflowId: input.workflowId,
                    version: input.version,
                    graph: input.graph,
                    catalogFingerprint: input.catalogFingerprint,
                    graphDigest: input.graphDigest,
                  })
                  .onConflictDoNothing({
                    target: [
                      workflowVersions.workflowId,
                      workflowVersions.version,
                    ],
                  })
                  .returning();
                if (!minted) {
                  return { stale: true };
                }

                return activatePublishedVersion(tx, {
                  workflowId: input.workflowId,
                  version: minted,
                  draftGraph: input.draftGraph,
                  eventSubscriptions: input.eventSubscriptions,
                });
              })
          ),

        pruneUnreferencedVersions: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                // The window read as an offset into the version order: this is
                // the newest version outside it, so everything at or below is a
                // candidate. No row means the workflow has nothing to sweep. A
                // publish racing this can only raise the cutoff, which makes a
                // stale read here conservative rather than permissive.
                const [cutoff] = await tx
                  .select({ version: workflowVersions.version })
                  .from(workflowVersions)
                  .where(eq(workflowVersions.workflowId, input.workflowId))
                  .orderBy(desc(workflowVersions.version))
                  .limit(1)
                  .offset(input.keepNewest);
                if (!cutoff) {
                  return [];
                }

                // Correlated against the outer `workflow_versions` row, so the
                // same pair serves the claim and the delete's re-check. Both
                // statements ask it; that repetition is the design.
                const unreferenced = and(
                  notExists(
                    tx
                      .select({ pinned: sql`1` })
                      .from(workflowExecutions)
                      .where(
                        eq(
                          workflowExecutions.workflowVersionId,
                          workflowVersions.id
                        )
                      )
                  ),
                  notExists(
                    tx
                      .select({ published: sql`1` })
                      .from(workflows)
                      .where(
                        eq(workflows.publishedVersionId, workflowVersions.id)
                      )
                  )
                );

                const claimed = await tx
                  .select({ id: workflowVersions.id })
                  .from(workflowVersions)
                  .where(
                    and(
                      eq(workflowVersions.workflowId, input.workflowId),
                      lte(workflowVersions.version, cutoff.version),
                      unreferenced
                    )
                  )
                  .orderBy(workflowVersions.version)
                  .limit(input.limit)
                  .for("update", { skipLocked: true });
                if (claimed.length === 0) {
                  return [];
                }

                const deleted = await tx
                  .delete(workflowVersions)
                  .where(
                    and(
                      inArray(
                        workflowVersions.id,
                        claimed.map((row) => row.id)
                      ),
                      unreferenced
                    )
                  )
                  .returning({ id: workflowVersions.id });

                return deleted.map((row) => row.id);
              })
          ),
      };
    })
  );

async function activatePublishedVersion(
  tx: RovaDatabase | RovaTransaction,
  input: {
    workflowId: string;
    version: WorkflowVersion;
    draftGraph: SerializedWorkflowGraph;
    eventSubscriptions: WorkflowEventSubscriptionRow[];
  }
): Promise<{ workflow: Workflow; version: WorkflowVersion } | null> {
  const updated = await tx
    .update(workflows)
    .set({
      publishedVersionId: input.version.id,
      // Keep the draft aligned with what was just published so a subsequent
      // edit starts from the published content.
      graph: input.draftGraph,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, input.workflowId))
    .returning();

  const workflow = updated.at(0);
  if (!workflow) {
    return null;
  }

  await tx
    .delete(workflowEventSubscriptions)
    .where(eq(workflowEventSubscriptions.workflowId, input.workflowId));

  if (input.eventSubscriptions.length > 0) {
    await tx
      .insert(workflowEventSubscriptions)
      .values(input.eventSubscriptions);
  }

  return { workflow, version: input.version };
}
