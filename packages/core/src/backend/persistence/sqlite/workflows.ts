import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";
import type { Workflow, WorkflowVersion } from "#src/backend/lib/db/schema";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import {
  asPublishedVersion,
  WorkflowRepo,
  type EventSubscriber,
  type WorkflowEventSubscriptionRow,
  type WorkflowVersionHistoryRow,
  type WorkflowVersionUsageRow,
} from "#src/backend/services/workflows/repo";
import { workflowVersionUsageRow } from "#src/backend/services/workflows/repo/version-row";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteReadExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeGraph } from "#src/backend/persistence/sqlite/database";
import {
  workflowEventSubscriptions,
  workflowExecutions,
  workflowVersions,
  workflowWaitStates,
  workflows,
} from "#src/backend/persistence/sqlite/schema";
import { isSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

function workflowMode(value: string): Workflow["mode"] {
  if (value !== "live" && value !== "test") {
    throw new Error("Invalid SQLite workflow mode");
  }
  return value;
}

function workflowVisibility(value: string): Workflow["visibility"] {
  if (value !== "private" && value !== "public") {
    throw new Error("Invalid SQLite workflow visibility");
  }
  return value;
}

function workflowGraph(
  value: string,
  field = "graph"
): SerializedWorkflowGraph {
  const graph = JSON.parse(value);
  if (!isSerializedWorkflowGraph(graph)) {
    throw new Error(`Invalid SQLite ${field}`);
  }
  return graph;
}

function workflowIsPaused(value: number): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error("Invalid SQLite is_paused");
  }
  return value === 1;
}

function workflowVersionKind(value: string): WorkflowVersionKind {
  const kind = WORKFLOW_VERSION_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new Error("Invalid SQLite kind");
  return kind;
}

export function sqliteWorkflow(row: typeof workflows.$inferSelect): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: workflowGraph(row.graph),
    isPaused: workflowIsPaused(row.isPaused),
    mode: workflowMode(row.mode),
    visibility: workflowVisibility(row.visibility),
    publishedVersionId: row.publishedVersionId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function sqliteWorkflowVersion(
  row: typeof workflowVersions.$inferSelect
): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    kind: workflowVersionKind(row.kind),
    graph: workflowGraph(row.graph),
    catalogFingerprint: row.catalogFingerprint,
    graphDigest: row.graphDigest,
    publishedAt: new Date(row.publishedAt),
  };
}

function replaceSubscriptions(
  database: SqliteExecutor,
  workflowId: string,
  rows: WorkflowEventSubscriptionRow[]
) {
  return Effect.gen(function* () {
    yield* database
      .delete(workflowEventSubscriptions)
      .where(eq(workflowEventSubscriptions.workflowId, workflowId));
    for (const row of rows) {
      yield* database.insert(workflowEventSubscriptions).values(row);
    }
  });
}

function findWorkflow(database: SqliteReadExecutor, workflowId: string) {
  return database
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get()
    .pipe(Effect.map((row) => (row ? sqliteWorkflow(row) : null)));
}

function publishedPair(database: SqliteReadExecutor, workflowId: string) {
  return database
    .select({ workflow: workflows, version: workflowVersions })
    .from(workflows)
    .leftJoin(
      workflowVersions,
      eq(workflowVersions.id, workflows.publishedVersionId)
    )
    .where(eq(workflows.id, workflowId))
    .get()
    .pipe(
      Effect.map((row) => {
        if (!row) return null;
        return {
          workflow: sqliteWorkflow(row.workflow),
          publishedVersion: asPublishedVersion(
            row.version ? sqliteWorkflowVersion(row.version) : null
          ),
        };
      })
    );
}

function stalePublication(): { stale: true } {
  return { stale: true };
}

function addEventSubscriber(
  subscribers: Map<string, EventSubscriber>,
  row: {
    id: string;
    role: string;
    correlationPath: string | null;
    connectionId: string | null;
  }
): void {
  if (row.role !== "start" && row.role !== "cancel" && row.role !== "wait") {
    throw new Error("Invalid SQLite subscription role");
  }
  const existing = subscribers.get(row.id);
  if (existing) {
    if (!existing.roles.includes(row.role)) existing.roles.push(row.role);
    return;
  }
  subscribers.set(row.id, {
    id: row.id,
    roles: [row.role],
    correlationPath: row.correlationPath,
    connectionId: row.connectionId,
  });
}

export function makeSqliteWorkflowRepo(
  store: SqliteDatabase
): WorkflowRepo["Service"] {
  return {
    listSummariesNewestFirst: store.read((database) =>
      database
        .select({
          id: workflows.id,
          name: workflows.name,
          description: workflows.description,
          isPaused: workflows.isPaused,
          mode: workflows.mode,
          visibility: workflows.visibility,
          publishedVersionId: workflows.publishedVersionId,
          createdAt: workflows.createdAt,
          updatedAt: workflows.updatedAt,
        })
        .from(workflows)
        .orderBy(desc(workflows.updatedAt))
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: row.id,
              name: row.name,
              description: row.description,
              isPaused: workflowIsPaused(row.isPaused),
              mode: workflowMode(row.mode),
              visibility: workflowVisibility(row.visibility),
              publishedVersionId: row.publishedVersionId,
              createdAt: new Date(row.createdAt),
              updatedAt: new Date(row.updatedAt),
            }))
          )
        )
    ),
    findById: (workflowId) =>
      store.read((database) => findWorkflow(database, workflowId)),
    existsById: (workflowId) =>
      store.read((database) =>
        database
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .limit(1)
          .get()
          .pipe(Effect.map(Boolean))
      ),
    hasWithName: (name) =>
      store.read((database) =>
        database
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.name, name))
          .limit(1)
          .get()
          .pipe(Effect.map(Boolean))
      ),
    hasOtherWithName: ({ name, excludingWorkflowId }) =>
      store.read((database) =>
        database
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(eq(workflows.name, name), ne(workflows.id, excludingWorkflowId))
          )
          .limit(1)
          .get()
          .pipe(Effect.map(Boolean))
      ),
    listEventSubscribers: (eventName) =>
      store.read((database) =>
        Effect.gen(function* () {
          const subscribers = new Map<string, EventSubscriber>();
          const direct = yield* database
            .select({
              id: workflows.id,
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
                eq(workflows.isPaused, 0)
              )
            );
          for (const row of direct) addEventSubscriber(subscribers, row);
          const waits = yield* database
            .selectDistinct({
              id: workflows.id,
              role: sql<string>`'wait'`.as("role"),
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
                eq(
                  workflowEventSubscriptions.workflowId,
                  workflowWaitStates.workflowId
                ),
                eq(workflowEventSubscriptions.eventName, eventName),
                eq(workflowEventSubscriptions.role, "wait")
              )
            )
            .where(
              and(
                eq(workflowWaitStates.status, "waiting"),
                eq(workflows.isPaused, 0),
                sql`exists (
                  select 1 from json_each(${workflowWaitStates.subscribedEvents}) e
                  where e.value = ${eventName}
                )`
              )
            );
          for (const row of waits) addEventSubscriber(subscribers, row);
          return [...subscribers.values()];
        })
      ),
    insert: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          yield* database.insert(workflows).values({
            id: input.id,
            name: input.name,
            description: input.description ?? null,
            graph: encodeGraph(input.graph),
            isPaused: input.isPaused === true ? 1 : 0,
            mode: input.mode ?? "live",
            visibility: input.visibility ?? "private",
            publishedVersionId: null,
            createdAt: now,
            updatedAt: now,
          });
          yield* replaceSubscriptions(
            database,
            input.id,
            input.eventSubscriptions
          );
          const workflow = yield* findWorkflow(database, input.id);
          if (!workflow) throw new Error("Inserted SQLite workflow is missing");
          return workflow;
        })
      ),
    findPausedById: (workflowId) =>
      store.read((database) =>
        database
          .select({ id: workflows.id, isPaused: workflows.isPaused })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .get()
          .pipe(
            Effect.map((row) =>
              row
                ? { id: row.id, isPaused: workflowIsPaused(row.isPaused) }
                : null
            )
          )
      ),
    setPaused: ({ workflowId, isPaused }) =>
      store.write((database) =>
        database
          .update(workflows)
          .set({ isPaused: isPaused ? 1 : 0, updatedAt: Date.now() })
          .where(eq(workflows.id, workflowId))
      ),
    update: ({ workflowId, updates, eventSubscriptions }) =>
      store.write((database) =>
        Effect.gen(function* () {
          const changes: Partial<typeof workflows.$inferInsert> = {
            updatedAt: updates.updatedAt.getTime(),
          };
          if (updates.name !== undefined) changes.name = updates.name;
          if (updates.description !== undefined) {
            changes.description = updates.description;
          }
          if (updates.graph !== undefined) {
            changes.graph = encodeGraph(updates.graph);
          }
          if (updates.mode !== undefined) changes.mode = updates.mode;
          const changed = yield* database
            .update(workflows)
            .set(changes)
            .where(eq(workflows.id, workflowId))
            .returning({ id: workflows.id })
            .get();
          if (!changed) return null;
          if (eventSubscriptions !== "unchanged") {
            yield* replaceSubscriptions(
              database,
              workflowId,
              eventSubscriptions
            );
          }
          return yield* findWorkflow(database, workflowId);
        })
      ),
    deleteById: (workflowId) =>
      store.write((database) =>
        database.delete(workflows).where(eq(workflows.id, workflowId))
      ),
    findCurrent: store.read((database) =>
      database
        .select()
        .from(workflows)
        .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
        .orderBy(desc(workflows.updatedAt))
        .limit(1)
        .get()
        .pipe(Effect.map((row) => (row ? sqliteWorkflow(row) : null)))
    ),
    insertCurrent: ({ id, graph }) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          yield* database.insert(workflows).values({
            id,
            name: CURRENT_WORKFLOW_NAME,
            description: "Auto-saved current workflow",
            graph: encodeGraph(graph),
            isPaused: 0,
            mode: "live",
            visibility: "private",
            publishedVersionId: null,
            createdAt: now,
            updatedAt: now,
          });
          return yield* findWorkflow(database, id);
        })
      ),
    findLatestVersion: (workflowId) =>
      store.read((database) =>
        database
          .select({ version: workflowVersions.version })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              eq(workflowVersions.kind, "published")
            )
          )
          .orderBy(desc(workflowVersions.version))
          .limit(1)
          .get()
          .pipe(
            Effect.map((row) =>
              row?.version === null || row === undefined
                ? null
                : { version: row.version }
            )
          )
      ),
    listVersionHistoryPage: ({ workflowId, limit, cursor }) =>
      store.read((database) => {
        const isCurrent = sql<number>`coalesce(${workflowVersions.id} = ${workflows.publishedVersionId}, 0)`;
        return database
          .select({
            id: workflowVersions.id,
            version: workflowVersions.version,
            publishedAt: workflowVersions.publishedAt,
            isCurrent,
          })
          .from(workflowVersions)
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              eq(workflowVersions.kind, "published"),
              cursor ? lt(workflowVersions.version, cursor.version) : undefined
            )
          )
          .orderBy(desc(workflowVersions.version))
          .limit(limit + 1)
          .pipe(
            Effect.map((rows) =>
              rows.map((row): WorkflowVersionHistoryRow => {
                if (row.version === null) {
                  throw new Error("Invalid SQLite published version");
                }
                return {
                  id: row.id,
                  version: row.version,
                  publishedAt: new Date(row.publishedAt),
                  isCurrent: row.isCurrent === 1,
                };
              })
            )
          );
      }),
    listVersionUsage: (workflowId) =>
      store.read((database) => {
        const activeRuns = database
          .select({
            workflowVersionId: workflowExecutions.workflowVersionId,
            activeRunCount: sql<number>`count(*)`.as("active_run_count"),
            oldestActiveRunAt: sql<
              number | null
            >`min(${workflowExecutions.startedAt})`.as("oldest_active_run_at"),
          })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES)
            )
          )
          .groupBy(workflowExecutions.workflowVersionId)
          .as("active_runs");
        const isCurrent = sql<number>`coalesce(${workflowVersions.id} = ${workflows.publishedVersionId}, 0)`;
        const publishedVersion = sql<
          number | null
        >`case when ${workflowVersions.kind} = 'published' then ${workflowVersions.version} end`;
        const draftPublishedAt = sql<
          number | null
        >`case when ${workflowVersions.kind} = 'draft_snapshot' then ${workflowVersions.publishedAt} end`;
        const draftId = sql<
          string | null
        >`case when ${workflowVersions.kind} = 'draft_snapshot' then ${workflowVersions.id} end`;
        return database
          .select({
            version: workflowVersions,
            isCurrent,
            activeRunCount: sql<number>`coalesce(${activeRuns.activeRunCount}, 0)`,
            oldestActiveRunAt: activeRuns.oldestActiveRunAt,
          })
          .from(workflowVersions)
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .leftJoin(
            activeRuns,
            eq(activeRuns.workflowVersionId, workflowVersions.id)
          )
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              or(
                eq(workflowVersions.id, workflows.publishedVersionId),
                isNotNull(activeRuns.workflowVersionId)
              )
            )
          )
          .orderBy(
            desc(isCurrent),
            desc(publishedVersion),
            desc(draftPublishedAt),
            desc(draftId)
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row): WorkflowVersionUsageRow => {
                const version = sqliteWorkflowVersion(row.version);
                return workflowVersionUsageRow({
                  id: version.id,
                  kind: version.kind,
                  version: version.version,
                  graph: version.graph,
                  catalogFingerprint: version.catalogFingerprint,
                  publishedAt: version.publishedAt,
                  isCurrent: row.isCurrent === 1,
                  activeRunCount: row.activeRunCount,
                  oldestActiveRunAt:
                    row.oldestActiveRunAt === null
                      ? null
                      : new Date(row.oldestActiveRunAt),
                });
              })
            )
          );
      }),
    findVersionById: (versionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.id, versionId))
          .get()
          .pipe(Effect.map((row) => (row ? sqliteWorkflowVersion(row) : null)))
      ),
    findPublishedVersion: (workflowId) =>
      store.read((database) =>
        publishedPair(database, workflowId).pipe(
          Effect.map((pair) => pair?.publishedVersion ?? null)
        )
      ),
    findByIdWithPublishedVersion: (workflowId) =>
      store.read((database) => publishedPair(database, workflowId)),
    findByIdWithPublishedVersionForRun: (workflowId) =>
      store.read((database) =>
        publishedPair(database, workflowId).pipe(
          Effect.map((pair) => {
            if (!pair) return null;
            const { id, name, mode, isPaused } = pair.workflow;
            return {
              workflow: { id, name, mode, isPaused },
              publishedVersion: pair.publishedVersion,
            };
          })
        )
      ),
    findByIdWithDraftGraphForRun: (workflowId) =>
      store.read((database) =>
        findWorkflow(database, workflowId).pipe(
          Effect.map((workflow) => {
            if (!workflow) return null;
            const { id, name, mode, isPaused } = workflow;
            return {
              workflow: { id, name, mode, isPaused },
              draftGraph: workflow.graph,
            };
          })
        )
      ),
    insertPublishedVersion: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          if (!(yield* findWorkflow(database, input.workflowId))) return null;
          const publishedAt = Date.now();
          const inserted = yield* database
            .insert(workflowVersions)
            .values({
              id: input.versionId,
              workflowId: input.workflowId,
              version: input.version,
              kind: "published",
              graph: encodeGraph(input.graph),
              catalogFingerprint: input.catalogFingerprint,
              graphDigest: input.graphDigest,
              publishedAt,
            })
            .onConflictDoNothing({
              target: [workflowVersions.workflowId, workflowVersions.version],
            })
            .returning({ id: workflowVersions.id })
            .get();
          if (!inserted) return stalePublication();
          const expectedPublication =
            input.expectedPublishedVersionId === null
              ? isNull(workflows.publishedVersionId)
              : eq(
                  workflows.publishedVersionId,
                  input.expectedPublishedVersionId
                );
          const changed = yield* database
            .update(workflows)
            .set({
              publishedVersionId: input.versionId,
              graph: encodeGraph(input.draftGraph),
              updatedAt: Date.now(),
            })
            .where(and(eq(workflows.id, input.workflowId), expectedPublication))
            .returning({ id: workflows.id })
            .get();
          if (!changed) {
            yield* database
              .delete(workflowVersions)
              .where(eq(workflowVersions.id, input.versionId));
            return (yield* findWorkflow(database, input.workflowId))
              ? stalePublication()
              : null;
          }
          yield* replaceSubscriptions(
            database,
            input.workflowId,
            input.eventSubscriptions
          );
          const workflow = yield* findWorkflow(database, input.workflowId);
          const versionRow = yield* database
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.id, input.versionId))
            .get();
          const version = asPublishedVersion(
            versionRow ? sqliteWorkflowVersion(versionRow) : null
          );
          if (!workflow || !version) {
            throw new Error("Published SQLite version is missing");
          }
          return { workflow, version };
        })
      ),
    freezeDraftSnapshot: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          // Identical graphs encode to identical text. Reuse only a snapshot an
          // Execution already references: an unreferenced snapshot is private
          // to another start that may still delete it after a refused gate.
          const graph = encodeGraph(input.graph);
          const existing = yield* database
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
                eq(workflowVersions.graph, graph),
                sql`exists (
                  select 1 from ${workflowExecutions}
                  where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id}
                )`
              )
            )
            .orderBy(desc(workflowVersions.publishedAt))
            .limit(1)
            .get();
          if (existing) return sqliteWorkflowVersion(existing);
          yield* database.insert(workflowVersions).values({
            id: input.versionId,
            workflowId: input.workflowId,
            version: null,
            kind: "draft_snapshot",
            graph,
            catalogFingerprint: input.catalogFingerprint,
            graphDigest: input.graphDigest,
            publishedAt: Date.now(),
          });
          const row = yield* database
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.id, input.versionId))
            .get();
          if (!row) throw new Error("The draft snapshot was not written");
          return sqliteWorkflowVersion(row);
        })
      ),
    deleteUnreferencedDraftSnapshot: (versionId) =>
      store.write((database) =>
        database
          .delete(workflowVersions)
          .where(
            and(
              eq(workflowVersions.id, versionId),
              eq(workflowVersions.kind, "draft_snapshot"),
              sql`not exists (
                select 1 from ${workflowExecutions}
                where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id}
              )`
            )
          )
          .returning({ id: workflowVersions.id })
          .get()
          .pipe(Effect.map(Boolean))
      ),
  };
}
