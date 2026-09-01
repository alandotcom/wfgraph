import { Effect } from "effect";
import { sql, type SQL } from "drizzle-orm";
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
} from "#src/backend/persistence/sqlite/database";
import {
  encodeGraph,
  optionalDate,
  optionalNumber,
  optionalString,
  requiredBoolean,
  requiredDate,
  requiredGraph,
  requiredNumber,
  requiredString,
  requiredVersionKind,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";

type Row = Record<string, unknown>;

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

export function sqliteWorkflow(row: Row): Workflow {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    description: optionalString(row, "description"),
    graph: requiredGraph(row),
    isPaused: requiredBoolean(row, "is_paused"),
    mode: workflowMode(requiredString(row, "mode")),
    visibility: workflowVisibility(requiredString(row, "visibility")),
    publishedVersionId: optionalString(row, "published_version_id"),
    createdAt: requiredDate(row, "created_at"),
    updatedAt: requiredDate(row, "updated_at"),
  };
}

export function sqliteWorkflowVersion(row: Row, prefix = ""): WorkflowVersion {
  return {
    id: requiredString(row, `${prefix}id`),
    workflowId: requiredString(row, `${prefix}workflow_id`),
    version: optionalNumber(row, `${prefix}version`),
    kind: requiredVersionKind(row, `${prefix}kind`),
    graph: requiredGraph(row, `${prefix}graph`),
    catalogFingerprint: requiredString(row, `${prefix}catalog_fingerprint`),
    graphDigest: requiredString(row, `${prefix}graph_digest`),
    publishedAt: requiredDate(row, `${prefix}published_at`),
  };
}

function replaceSubscriptions(
  database: SqliteExecutor,
  workflowId: string,
  rows: WorkflowEventSubscriptionRow[]
) {
  return Effect.gen(function* () {
    yield* database.run(
      sql`delete from workflow_event_subscriptions where workflow_id = ${workflowId}`
    );
    for (const row of rows) {
      yield* database.run(sql`
        insert into workflow_event_subscriptions
          (workflow_id, event_name, role, correlation_path, connection_id)
        values (${row.workflowId}, ${row.eventName}, ${row.role},
          ${row.correlationPath}, ${row.connectionId})
      `);
    }
  });
}

function findWorkflow(database: SqliteExecutor, workflowId: string) {
  return database
    .get<Row>(sql`select * from workflows where id = ${workflowId}`)
    .pipe(Effect.map((row) => (row ? sqliteWorkflow(row) : null)));
}

function publishedPair(database: SqliteExecutor, workflowId: string) {
  return database
    .get<Row>(sql`
      select w.*,
        v.id as version_id, v.workflow_id as version_workflow_id,
        v.version as version_version, v.kind as version_kind,
        v.graph as version_graph,
        v.catalog_fingerprint as version_catalog_fingerprint,
        v.graph_digest as version_graph_digest,
        v.published_at as version_published_at
      from workflows w
      left join workflow_versions v on v.id = w.published_version_id
      where w.id = ${workflowId}
    `)
    .pipe(
      Effect.map((row) => {
        if (!row) return null;
        return {
          workflow: sqliteWorkflow(row),
          publishedVersion:
            row.version_id === null
              ? null
              : asPublishedVersion(sqliteWorkflowVersion(row, "version_")),
        };
      })
    );
}

function stalePublication(): { stale: true } {
  return { stale: true };
}

function addEventSubscriber(
  subscribers: Map<string, EventSubscriber>,
  row: Row
): void {
  const id = requiredString(row, "id");
  const role = requiredString(row, "role");
  if (role !== "start" && role !== "cancel" && role !== "wait") {
    throw new Error("Invalid SQLite subscription role");
  }
  const existing = subscribers.get(id);
  if (existing) {
    if (!existing.roles.includes(role)) existing.roles.push(role);
    return;
  }
  subscribers.set(id, {
    id,
    roles: [role],
    correlationPath: optionalString(row, "correlation_path"),
    connectionId: optionalString(row, "connection_id"),
  });
}

export function makeSqliteWorkflowRepo(
  store: SqliteDatabase
): WorkflowRepo["Service"] {
  return {
    listSummariesNewestFirst: store.read((database) =>
      database
        .all<Row>(sql`
          select id, name, description, is_paused, mode, visibility,
            published_version_id, created_at, updated_at
          from workflows order by updated_at desc
        `)
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: requiredString(row, "id"),
              name: requiredString(row, "name"),
              description: optionalString(row, "description"),
              isPaused: requiredBoolean(row, "is_paused"),
              mode: workflowMode(requiredString(row, "mode")),
              visibility: workflowVisibility(requiredString(row, "visibility")),
              publishedVersionId: optionalString(row, "published_version_id"),
              createdAt: requiredDate(row, "created_at"),
              updatedAt: requiredDate(row, "updated_at"),
            }))
          )
        )
    ),
    findById: (workflowId) =>
      store.read((database) => findWorkflow(database, workflowId)),
    existsById: (workflowId) =>
      store.read((database) =>
        database
          .get<Row>(
            sql`select 1 as present from workflows where id = ${workflowId}`
          )
          .pipe(Effect.map(Boolean))
      ),
    hasWithName: (name) =>
      store.read((database) =>
        database
          .get<Row>(
            sql`select 1 as present from workflows where name = ${name}`
          )
          .pipe(Effect.map(Boolean))
      ),
    hasOtherWithName: ({ name, excludingWorkflowId }) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select 1 as present from workflows
            where name = ${name} and id <> ${excludingWorkflowId}
          `)
          .pipe(Effect.map(Boolean))
      ),
    listEventSubscribers: (eventName) =>
      store.read((database) =>
        Effect.gen(function* () {
          const subscribers = new Map<string, EventSubscriber>();
          const direct = yield* database.all<Row>(sql`
            select w.id, s.role, s.correlation_path, s.connection_id
            from workflow_event_subscriptions s
            join workflows w on w.id = s.workflow_id
            where s.event_name = ${eventName} and s.role <> 'wait'
              and w.is_paused = 0
          `);
          for (const row of direct) addEventSubscriber(subscribers, row);
          const waits = yield* database.all<Row>(sql`
            select distinct w.id, 'wait' as role,
              s.correlation_path, s.connection_id
            from workflow_wait_states ws
            join workflows w on w.id = ws.workflow_id
            left join workflow_event_subscriptions s
              on s.workflow_id = ws.workflow_id
              and s.event_name = ${eventName} and s.role = 'wait'
            where ws.status = 'waiting' and w.is_paused = 0
              and exists (
                select 1 from json_each(ws.subscribed_events) e
                where e.value = ${eventName}
              )
          `);
          for (const row of waits) addEventSubscriber(subscribers, row);
          return [...subscribers.values()];
        })
      ),
    insert: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          yield* database.run(sql`
            insert into workflows (
              id, name, description, graph, is_paused, mode, visibility,
              published_version_id, created_at, updated_at
            ) values (
              ${input.id}, ${input.name}, ${input.description ?? null},
              ${encodeGraph(input.graph)}, ${input.isPaused === true ? 1 : 0},
              ${input.mode ?? "live"}, ${input.visibility ?? "private"}, null,
              ${now}, ${now}
            )
          `);
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
          .get<Row>(
            sql`select id, is_paused from workflows where id = ${workflowId}`
          )
          .pipe(
            Effect.map((row) =>
              row
                ? {
                    id: requiredString(row, "id"),
                    isPaused: requiredBoolean(row, "is_paused"),
                  }
                : null
            )
          )
      ),
    setPaused: ({ workflowId, isPaused }) =>
      store.write((database) =>
        database.run(sql`
          update workflows set is_paused = ${isPaused ? 1 : 0},
            updated_at = ${Date.now()} where id = ${workflowId}
        `)
      ),
    update: ({ workflowId, updates, eventSubscriptions }) =>
      store.write((database) =>
        Effect.gen(function* () {
          const assignments: SQL[] = [
            sql`updated_at = ${updates.updatedAt.getTime()}`,
          ];
          if (updates.name !== undefined)
            assignments.push(sql`name = ${updates.name}`);
          if (updates.description !== undefined) {
            assignments.push(sql`description = ${updates.description}`);
          }
          if (updates.graph !== undefined) {
            assignments.push(sql`graph = ${encodeGraph(updates.graph)}`);
          }
          if (updates.mode !== undefined)
            assignments.push(sql`mode = ${updates.mode}`);
          const changed = yield* database.get<Row>(sql`
            update workflows set ${sql.join(assignments, sql`, `)}
            where id = ${workflowId} returning id
          `);
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
        database.run(sql`delete from workflows where id = ${workflowId}`)
      ),
    findCurrent: store.read((database) =>
      database
        .get<Row>(sql`
          select * from workflows where name = ${CURRENT_WORKFLOW_NAME}
          order by updated_at desc limit 1
        `)
        .pipe(Effect.map((row) => (row ? sqliteWorkflow(row) : null)))
    ),
    insertCurrent: ({ id, graph }) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          yield* database.run(sql`
            insert into workflows (
              id, name, description, graph, is_paused, mode, visibility,
              published_version_id, created_at, updated_at
            ) values (
              ${id}, ${CURRENT_WORKFLOW_NAME}, 'Auto-saved current workflow',
              ${encodeGraph(graph)}, 0, 'live', 'private', null, ${now}, ${now}
            )
          `);
          return yield* findWorkflow(database, id);
        })
      ),
    findLatestVersion: (workflowId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select version from workflow_versions
            where workflow_id = ${workflowId} and kind = 'published'
            order by version desc limit 1
          `)
          .pipe(
            Effect.map((row) =>
              row ? { version: requiredNumber(row, "version") } : null
            )
          )
      ),
    listVersionHistoryPage: ({ workflowId, limit, cursor }) =>
      store.read((database) =>
        database
          .all<Row>(sql`
            select v.id, v.version, v.published_at,
              v.id = w.published_version_id as is_current
            from workflow_versions v join workflows w on w.id = v.workflow_id
            where v.workflow_id = ${workflowId} and v.kind = 'published'
              and (${cursor?.version ?? null} is null or v.version < ${cursor?.version ?? null})
            order by v.version desc limit ${limit + 1}
          `)
          .pipe(
            Effect.map((rows) =>
              rows.map((row): WorkflowVersionHistoryRow => ({
                id: requiredString(row, "id"),
                version: requiredNumber(row, "version"),
                publishedAt: requiredDate(row, "published_at"),
                isCurrent: requiredBoolean(row, "is_current"),
              }))
            )
          )
      ),
    listVersionUsage: (workflowId) =>
      store.read((database) =>
        database
          .all<Row>(sql`
            select v.*, coalesce(v.id = w.published_version_id, 0) as is_current,
              coalesce(a.active_run_count, 0) as active_run_count,
              a.oldest_active_run_at
            from workflow_versions v join workflows w on w.id = v.workflow_id
            left join (
              select workflow_version_id, count(*) as active_run_count,
                min(started_at) as oldest_active_run_at
              from workflow_executions where workflow_id = ${workflowId}
                and status in (${sql.raw(SQLITE_IN_FLIGHT_EXECUTION_STATUSES)})
              group by workflow_version_id
            ) a on a.workflow_version_id = v.id
            where v.workflow_id = ${workflowId}
              and (v.id = w.published_version_id or a.workflow_version_id is not null)
            order by is_current desc,
              case when v.kind = 'published' then v.version end desc,
              case when v.kind = 'draft_snapshot' then v.published_at end desc,
              case when v.kind = 'draft_snapshot' then v.id end desc
          `)
          .pipe(
            Effect.map((rows) =>
              rows.map((row): WorkflowVersionUsageRow => {
                const version = sqliteWorkflowVersion(row);
                return workflowVersionUsageRow({
                  id: version.id,
                  kind: version.kind,
                  version: version.version,
                  graph: version.graph,
                  catalogFingerprint: version.catalogFingerprint,
                  publishedAt: version.publishedAt,
                  isCurrent: requiredBoolean(row, "is_current"),
                  activeRunCount: requiredNumber(row, "active_run_count"),
                  oldestActiveRunAt: optionalDate(row, "oldest_active_run_at"),
                });
              })
            )
          )
      ),
    findVersionById: (versionId) =>
      store.read((database) =>
        database
          .get<Row>(
            sql`select * from workflow_versions where id = ${versionId}`
          )
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
          const publishedAt = new Date();
          const inserted = yield* database.get<Row>(sql`
            insert into workflow_versions (
              id, workflow_id, version, kind, graph, catalog_fingerprint,
              graph_digest, published_at
            ) values (
              ${input.versionId}, ${input.workflowId}, ${input.version}, 'published',
              ${encodeGraph(input.graph)}, ${input.catalogFingerprint},
              ${input.graphDigest}, ${publishedAt.getTime()}
            ) on conflict (workflow_id, version) do nothing returning id
          `);
          if (!inserted) return stalePublication();
          const changed = yield* database.get<Row>(sql`
            update workflows set published_version_id = ${input.versionId},
              graph = ${encodeGraph(input.draftGraph)}, updated_at = ${Date.now()}
            where id = ${input.workflowId}
              and published_version_id is ${input.expectedPublishedVersionId}
            returning id
          `);
          if (!changed) {
            yield* database.run(
              sql`delete from workflow_versions where id = ${input.versionId}`
            );
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
          const versionRow = yield* database.get<Row>(
            sql`select * from workflow_versions where id = ${input.versionId}`
          );
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
          const existing = yield* database.get<Row>(sql`
            select * from workflow_versions
            where workflow_id = ${input.workflowId} and kind = 'draft_snapshot'
              and catalog_fingerprint = ${input.catalogFingerprint} and graph = ${graph}
              and exists (
                select 1 from workflow_executions
                where workflow_version_id = workflow_versions.id
              )
            order by published_at desc limit 1
          `);
          if (existing) return sqliteWorkflowVersion(existing);
          yield* database.run(sql`
            insert into workflow_versions (
              id, workflow_id, version, kind, graph, catalog_fingerprint,
              graph_digest, published_at
            ) values (
              ${input.versionId}, ${input.workflowId}, null, 'draft_snapshot',
              ${graph}, ${input.catalogFingerprint}, ${input.graphDigest}, ${Date.now()}
            )
          `);
          const row = yield* database.get<Row>(
            sql`select * from workflow_versions where id = ${input.versionId}`
          );
          if (!row) throw new Error("The draft snapshot was not written");
          return sqliteWorkflowVersion(row);
        })
      ),
    deleteUnreferencedDraftSnapshot: (versionId) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            delete from workflow_versions
            where id = ${versionId} and kind = 'draft_snapshot'
              and not exists (
                select 1 from workflow_executions
                where workflow_version_id = workflow_versions.id
              )
            returning id
          `)
          .pipe(Effect.map(Boolean))
      ),
  };
}
