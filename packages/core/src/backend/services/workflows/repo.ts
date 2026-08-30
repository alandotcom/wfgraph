import { and, arrayContains, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  type PublishedWorkflowVersion,
  type Workflow,
  type WorkflowVersion,
  workflowEventSubscriptions,
  type WorkflowMode,
  type WorkflowVisibility,
  workflows,
  workflowVersions,
  workflowWaitStates,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import type { WorkflowUpdateData } from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

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

export type WorkflowRunRow = Pick<
  Workflow,
  "id" | "name" | "mode" | "isPaused"
>;

/** The fields a version-history page needs, ordered by descending version. */
export type WorkflowVersionHistoryRow = Pick<
  WorkflowVersion,
  "id" | "publishedAt"
> & {
  version: number;
  /** Whether this row is the version the workflow currently publishes. */
  isCurrent: boolean;
};

/** Reports whether a version row is a published version or a draft snapshot. */
function isPublishedVersion(
  version: WorkflowVersion
): version is PublishedWorkflowVersion {
  return version.kind === "published" && version.version !== null;
}

/**
 * The same check for a row that may be absent. Every read of the publication
 * pointer returns a version row, null, or undefined, so they all pass through
 * here.
 */
export function asPublishedVersion(
  version: WorkflowVersion | null | undefined
): PublishedWorkflowVersion | null {
  return version && isPublishedVersion(version) ? version : null;
}

/**
 * The version number of a row that a query already restricted to published
 * versions.
 *
 * Only a draft snapshot leaves the column null, so a null here means the query
 * failed to exclude the snapshots. The throw reports that bug instead of
 * passing a bad number on.
 */
function publishedVersionNumber(value: number | null): number {
  if (value === null) {
    throw new Error("A published workflow version carries no version number");
  }
  return value;
}

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
  /**
   * The Connection a start or cancel of this Event must arrive on. Null for a
   * host Event, and for a wait-only subscriber whose match lives on the parked
   * row instead.
   */
  connectionId: string | null;
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
    /**
     * The newest published version for this workflow, or null when none exist.
     * Draft snapshots are skipped because they carry no version number, so they
     * cannot be the latest version or decide the next one.
     */
    readonly findLatestVersion: (
      workflowId: string
    ) => Effect.Effect<{ version: number } | null, DatabaseError>;
    /**
     * A version-history page for one workflow, newest version first.
     *
     * `cursor.version` is exclusive, so it returns versions strictly older than
     * that one. The result holds up to `limit + 1` rows; callers keep `limit`
     * rows and use the extra row to determine whether a next cursor exists.
     * Draft snapshots are left out because the history covers published
     * versions only.
     */
    readonly listVersionHistoryPage: (input: {
      workflowId: string;
      limit: number;
      cursor?: { version: number };
    }) => Effect.Effect<WorkflowVersionHistoryRow[], DatabaseError>;
    /**
     * One version by id, of either kind, or null when it is gone. The engine and
     * the run panel read a run's pinned version through this, so it must also
     * return the draft snapshots that the other version reads exclude.
     */
    readonly findVersionById: (
      versionId: string
    ) => Effect.Effect<WorkflowVersion | null, DatabaseError>;
    /**
     * The version `published_version_id` names, or null when the workflow is
     * gone or has never been published.
     */
    readonly findPublishedVersion: (
      workflowId: string
    ) => Effect.Effect<PublishedWorkflowVersion | null, DatabaseError>;
    /**
     * The workflow and the version it currently points at, in one round trip.
     * `publishedVersion` is null when the workflow exists but has never been
     * published.
     */
    readonly findByIdWithPublishedVersion: (
      workflowId: string
    ) => Effect.Effect<
      {
        workflow: Workflow;
        publishedVersion: PublishedWorkflowVersion | null;
      } | null,
      DatabaseError
    >;
    /**
     * The same pair as `findByIdWithPublishedVersion`, narrowed to what a run
     * reads off the workflow: `id`, `name`, `mode` and `isPaused`.
     *
     * The delivery fan-out and the manual-start preflight take this instead:
     * both gate and route a run off these four columns and never the draft
     * graph, which is what `findByIdWithPublishedVersion` still carries for the
     * editor's load. The published version rides along in full, because
     * preflight validates that graph.
     */
    readonly findByIdWithPublishedVersionForRun: (
      workflowId: string
    ) => Effect.Effect<
      {
        workflow: WorkflowRunRow;
        publishedVersion: PublishedWorkflowVersion | null;
      } | null,
      DatabaseError
    >;
    /**
     * The same four workflow columns as the read above, paired with the draft
     * graph, for a test-mode run of the graph the canvas holds.
     *
     * This is a separate read because the published path leaves the draft
     * column unread on purpose. That graph reaches megabytes on the workflows
     * every Event start goes through.
     */
    readonly findByIdWithDraftGraphForRun: (
      workflowId: string
    ) => Effect.Effect<
      {
        workflow: WorkflowRunRow;
        draftGraph: SerializedWorkflowGraph;
      } | null,
      DatabaseError
    >;
    /**
     * Claim a new version number (optimistic: insert only if still free), then
     * point the workflow at it only when the reviewed publication pointer still
     * matches, align the draft, and rewrite subscriptions.
     */
    readonly insertPublishedVersion: (input: {
      workflowId: string;
      versionId: string;
      version: number;
      /** The publication pointer carried by the confirmed review. */
      expectedPublishedVersionId: string | null;
      graph: SerializedWorkflowGraph;
      catalogFingerprint: string;
      graphDigest: string;
      draftGraph: SerializedWorkflowGraph;
      eventSubscriptions: WorkflowEventSubscriptionRow[];
    }) => Effect.Effect<InsertPublishedVersionResult, DatabaseError>;
    /**
     * Freezes the draft graph as a version a run can pin to, and returns the
     * row. When this workflow already has a snapshot of this exact graph under
     * this catalog, and an Execution already references that snapshot, that row
     * comes back instead of a new one. So `versionId` is a proposal, and the
     * caller pins the returned `id`. Repeated runs of an unchanged canvas share
     * one row from the second run onward.
     *
     * A snapshot no Execution references yet belongs to the request that
     * inserted it, which can still release it, so this never hands one to
     * another request.
     *
     * The call writes nothing else. It claims no version number and the
     * publication pointer does not move. The Event subscription index keeps
     * describing the published graph, so only a manual start runs a draft.
     */
    readonly freezeDraftSnapshot: (input: {
      workflowId: string;
      versionId: string;
      graph: SerializedWorkflowGraph;
      catalogFingerprint: string;
      graphDigest: string;
    }) => Effect.Effect<WorkflowVersion, DatabaseError>;
    /**
     * Deletes a draft snapshot that no Execution references, and keeps one that
     * an Execution does reference. A start refused after the freeze, such as a
     * first-wins concurrency refusal, calls this so the refusal leaves no row
     * behind. A concurrent start that pinned the same snapshot keeps it.
     * Returns whether a row was deleted.
     */
    readonly deleteUnreferencedDraftSnapshot: (
      versionId: string
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@wfgraph/core/WorkflowRepo") {}

/** Outcome of `insertPublishedVersion`: published, behind, or workflow missing. */
export type InsertPublishedVersionResult =
  | { workflow: Workflow; version: PublishedWorkflowVersion }
  | { stale: true }
  | null;

/** The four workflow columns a run reads before it starts. */
const RUN_WORKFLOW_COLUMNS = {
  id: true,
  name: true,
  mode: true,
  isPaused: true,
} as const;

/**
 * Load a workflow and its published version in one RQB round trip.
 *
 * `columns` narrows the workflow side for callers that only gate and route a
 * run; omitting it returns the full row. The published version is always the
 * whole `workflow_versions` row when present.
 */
async function findWorkflowWithPublishedVersion(
  db: WfGraphDatabase,
  workflowId: string,
  columns?: typeof RUN_WORKFLOW_COLUMNS
) {
  const row = await db.query.workflows.findFirst({
    where: { id: workflowId },
    ...(columns ? { columns } : {}),
    with: { publishedVersion: true },
  });

  if (!row) {
    return null;
  }

  const { publishedVersion, ...workflow } = row;
  return { workflow, publishedVersion: asPublishedVersion(publishedVersion) };
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
              where: { id: workflowId },
            });

            return workflow ?? null;
          }),

        existsById: (workflowId) =>
          database.query(async (db) => {
            const workflow = await db.query.workflows.findFirst({
              where: { id: workflowId },
              columns: { id: true },
            });

            return workflow !== undefined;
          }),

        hasWithName: (name) =>
          database.query(async (db) => {
            // Case-insensitive match against `workflows_name_ci_uidx`. Expression
            // predicates stay on the SQL builder; RQB's object `where` has no
            // clean form for `lower(name)` that is not an escape hatch.
            const [conflict] = await db
              .select({ id: workflows.id })
              .from(workflows)
              .where(sql`lower(${workflows.name}) = lower(${name})`)
              .limit(1);

            return conflict !== undefined;
          }),

        hasOtherWithName: (input) =>
          database.query(async (db) => {
            const [conflict] = await db
              .select({ id: workflows.id })
              .from(workflows)
              .where(
                and(
                  sql`lower(${workflows.name}) = lower(${input.name})`,
                  ne(workflows.id, input.excludingWorkflowId)
                )
              )
              .limit(1);

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
                  connectionId: workflowEventSubscriptions.connectionId,
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
                  connectionId: workflowEventSubscriptions.connectionId,
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
                connectionId: row.connectionId,
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
                connectionId: row.connectionId,
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
              where: { id: workflowId },
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
              .select({ version: workflowVersions.version })
              .from(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.workflowId, workflowId),
                  eq(workflowVersions.kind, "published")
                )
              )
              .orderBy(desc(workflowVersions.version))
              .limit(1);

            return row
              ? { version: publishedVersionNumber(row.version) }
              : null;
          }),

        listVersionHistoryPage: (input) =>
          database.query(async (db) => {
            const rows = await db
              .select({
                id: workflowVersions.id,
                version: workflowVersions.version,
                publishedAt: workflowVersions.publishedAt,
                isCurrent: sql<boolean>`${workflows.id} is not null`,
              })
              .from(workflowVersions)
              .leftJoin(
                workflows,
                and(
                  eq(workflows.id, input.workflowId),
                  eq(workflows.publishedVersionId, workflowVersions.id)
                )
              )
              .where(
                and(
                  eq(workflowVersions.workflowId, input.workflowId),
                  eq(workflowVersions.kind, "published"),
                  input.cursor
                    ? lt(workflowVersions.version, input.cursor.version)
                    : undefined
                )
              )
              .orderBy(desc(workflowVersions.version))
              .limit(input.limit + 1);

            return rows.map((row) => ({
              ...row,
              version: publishedVersionNumber(row.version),
            }));
          }),

        findVersionById: (versionId) =>
          database.query(async (db) => {
            const row = await db.query.workflowVersions.findFirst({
              where: { id: versionId },
            });

            return row ?? null;
          }),

        findPublishedVersion: (workflowId) =>
          database.query(async (db) => {
            const row = await db.query.workflows.findFirst({
              where: { id: workflowId },
              columns: { id: true },
              with: { publishedVersion: true },
            });

            return asPublishedVersion(row?.publishedVersion);
          }),

        findByIdWithPublishedVersion: (workflowId) =>
          database.query((db) =>
            findWorkflowWithPublishedVersion(db, workflowId)
          ),

        findByIdWithPublishedVersionForRun: (workflowId) =>
          database.query((db) =>
            findWorkflowWithPublishedVersion(
              db,
              workflowId,
              RUN_WORKFLOW_COLUMNS
            )
          ),

        findByIdWithDraftGraphForRun: (workflowId) =>
          database.query(async (db) => {
            const row = await db.query.workflows.findFirst({
              where: { id: workflowId },
              columns: { ...RUN_WORKFLOW_COLUMNS, graph: true },
            });

            if (!row) {
              return null;
            }

            const { graph, ...workflow } = row;
            return { workflow, draftGraph: graph };
          }),

        insertPublishedVersion: (input) =>
          database.query(
            async (db) =>
              await db.transaction(async (tx) => {
                // Verify before minting: a soft null after the insert would
                // commit an orphan version row. Presence here means the later
                // update cannot miss under the FK KEY SHARE the insert takes.
                const existing = await tx.query.workflows.findFirst({
                  where: { id: input.workflowId },
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
                    kind: "published",
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
                const published = asPublishedVersion(minted);
                if (!published) {
                  throw new Error("The minted version is not a published one");
                }

                const activated = await activatePublishedVersion(tx, {
                  workflowId: input.workflowId,
                  version: published,
                  expectedPublishedVersionId: input.expectedPublishedVersionId,
                  draftGraph: input.draftGraph,
                  eventSubscriptions: input.eventSubscriptions,
                });
                if (activated) {
                  return activated;
                }

                // The version number was ours, but another publish moved the
                // workflow pointer first. Remove this unobserved row before
                // reporting the optimistic conflict.
                await tx
                  .delete(workflowVersions)
                  .where(eq(workflowVersions.id, minted.id));
                return { stale: true };
              })
          ),

        freezeDraftSnapshot: (input) =>
          database.query(async (db) => {
            // jsonb equality is structural, so key order and whitespace in the
            // stored column do not affect the match.
            //
            // The EXISTS clause is what makes the reuse safe against a
            // concurrent start. A snapshot no Execution references yet is
            // private to the request that inserted it, and that request can
            // still release it if a later gate refuses the start. Reusing such
            // a row would let this run pin an id the other request is about to
            // delete. A referenced row can never be deleted, because
            // `deleteUnreferencedDraftSnapshot` refuses it.
            const [existing] = await db
              .select()
              .from(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.workflowId, input.workflowId),
                  eq(workflowVersions.kind, "draft_snapshot"),
                  eq(
                    workflowVersions.catalogFingerprint,
                    input.catalogFingerprint
                  ),
                  eq(workflowVersions.graph, input.graph),
                  sql`exists (select 1 from ${workflowExecutions} where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id})`
                )
              )
              .orderBy(desc(workflowVersions.publishedAt))
              .limit(1);
            if (existing) {
              return existing;
            }

            const [snapshot] = await db
              .insert(workflowVersions)
              .values({
                id: input.versionId,
                workflowId: input.workflowId,
                version: null,
                kind: "draft_snapshot",
                graph: input.graph,
                catalogFingerprint: input.catalogFingerprint,
                graphDigest: input.graphDigest,
              })
              .returning();

            if (!snapshot) {
              throw new Error("The draft snapshot was not written");
            }

            return snapshot;
          }),

        deleteUnreferencedDraftSnapshot: (versionId) =>
          database.query(async (db) => {
            // The NOT EXISTS clause keeps this delete from racing a concurrent
            // pin. That insert holds a share lock on the row, so the delete
            // waits for its transaction and then sees the reference.
            const deleted = await db
              .delete(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.id, versionId),
                  eq(workflowVersions.kind, "draft_snapshot"),
                  sql`not exists (select 1 from ${workflowExecutions} where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id})`
                )
              )
              .returning({ id: workflowVersions.id });
            return deleted.length > 0;
          }),
      };
    })
  );

async function activatePublishedVersion(
  tx: WfGraphDatabase | WfGraphTransaction,
  input: {
    workflowId: string;
    version: PublishedWorkflowVersion;
    expectedPublishedVersionId: string | null;
    draftGraph: SerializedWorkflowGraph;
    eventSubscriptions: WorkflowEventSubscriptionRow[];
  }
): Promise<{ workflow: Workflow; version: PublishedWorkflowVersion } | null> {
  const updated = await tx
    .update(workflows)
    .set({
      publishedVersionId: input.version.id,
      // Keep the draft aligned with what was just published so a subsequent
      // edit starts from the published content.
      graph: input.draftGraph,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflows.id, input.workflowId),
        input.expectedPublishedVersionId === null
          ? isNull(workflows.publishedVersionId)
          : eq(workflows.publishedVersionId, input.expectedPublishedVersionId)
      )
    )
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
