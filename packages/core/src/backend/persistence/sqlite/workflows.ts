import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  PublishedWorkflowVersion,
  Workflow,
  WorkflowVersion,
} from "#src/backend/lib/db/schema";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import {
  asPublishedVersion,
  WorkflowRepo,
  type EventSubscriber,
  type WorkflowEventSubscriptionRow,
  type WorkflowVersionHistoryRow,
} from "#src/backend/services/workflows/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  encodeGraph,
  optionalNumber,
  optionalString,
  requiredBoolean,
  requiredDate,
  requiredGraph,
  requiredNumber,
  requiredString,
  requiredVersionKind,
} from "#src/backend/persistence/sqlite/database";

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

export function sqliteWorkflow(row: Record<string, unknown>): Workflow {
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

export function sqliteWorkflowVersion(
  row: Record<string, unknown>,
  prefix = ""
): WorkflowVersion {
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
  database: DatabaseSync,
  workflowId: string,
  rows: WorkflowEventSubscriptionRow[]
): void {
  database
    .prepare("DELETE FROM workflow_event_subscriptions WHERE workflow_id = ?")
    .run(workflowId);
  const insert = database.prepare(
    `INSERT INTO workflow_event_subscriptions
     (workflow_id, event_name, role, correlation_path) VALUES (?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(row.workflowId, row.eventName, row.role, row.correlationPath);
  }
}

function findWorkflow(
  database: DatabaseSync,
  workflowId: string
): Workflow | null {
  const row = database
    .prepare("SELECT * FROM workflows WHERE id = ?")
    .get(workflowId);
  return row ? sqliteWorkflow(row) : null;
}

function publishedPair(
  database: DatabaseSync,
  workflowId: string
): {
  workflow: Workflow;
  publishedVersion: PublishedWorkflowVersion | null;
} | null {
  const row = database
    .prepare(
      `SELECT w.*,
         v.id AS version_id, v.workflow_id AS version_workflow_id,
         v.version AS version_version, v.kind AS version_kind,
         v.graph AS version_graph,
         v.catalog_fingerprint AS version_catalog_fingerprint,
         v.graph_digest AS version_graph_digest,
         v.published_at AS version_published_at
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.id = w.published_version_id
       WHERE w.id = ?`
    )
    .get(workflowId);
  if (!row) return null;
  return {
    workflow: sqliteWorkflow(row),
    publishedVersion:
      row.version_id === null
        ? null
        : asPublishedVersion(sqliteWorkflowVersion(row, "version_")),
  };
}

function stalePublication(): { stale: true } {
  return { stale: true };
}

function addEventSubscriber(
  subscribers: Map<string, EventSubscriber>,
  row: Record<string, unknown>
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
    name: requiredString(row, "name"),
    mode: workflowMode(requiredString(row, "mode")),
    roles: [role],
    correlationPath: optionalString(row, "correlation_path"),
  });
}

export function makeSqliteWorkflowRepo(
  store: SqliteDatabase
): WorkflowRepo["Service"] {
  return {
    listSummariesNewestFirst: store.read((database) =>
      database
        .prepare(
          `SELECT id, name, description, is_paused, mode, visibility,
                  published_version_id, created_at, updated_at
           FROM workflows ORDER BY updated_at DESC`
        )
        .all()
        .map((row) => ({
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
    ),
    findById: (workflowId) =>
      store.read((database) => findWorkflow(database, workflowId)),
    existsById: (workflowId) =>
      store.read(
        (database) =>
          database
            .prepare("SELECT 1 AS present FROM workflows WHERE id = ?")
            .get(workflowId) !== undefined
      ),
    hasWithName: (name) =>
      store.read(
        (database) =>
          database
            .prepare("SELECT 1 AS present FROM workflows WHERE name = ?")
            .get(name) !== undefined
      ),
    hasOtherWithName: ({ name, excludingWorkflowId }) =>
      store.read(
        (database) =>
          database
            .prepare(
              "SELECT 1 AS present FROM workflows WHERE name = ? AND id <> ?"
            )
            .get(name, excludingWorkflowId) !== undefined
      ),
    listEventSubscribers: (eventName) =>
      store.read((database) => {
        const subscribers = new Map<string, EventSubscriber>();

        for (const row of database
          .prepare(
            `SELECT w.id, w.name, w.mode, s.role, s.correlation_path
             FROM workflow_event_subscriptions s
             JOIN workflows w ON w.id = s.workflow_id
             WHERE s.event_name = ? AND s.role <> 'wait' AND w.is_paused = 0`
          )
          .all(eventName)) {
          addEventSubscriber(subscribers, row);
        }
        for (const row of database
          .prepare(
            `SELECT DISTINCT w.id, w.name, w.mode, 'wait' AS role,
                    s.correlation_path
             FROM workflow_wait_states ws
             JOIN workflows w ON w.id = ws.workflow_id
             LEFT JOIN workflow_event_subscriptions s
               ON s.workflow_id = ws.workflow_id
              AND s.event_name = ? AND s.role = 'wait'
             WHERE ws.status = 'waiting' AND w.is_paused = 0
               AND EXISTS (
                 SELECT 1 FROM json_each(ws.subscribed_events) e
                 WHERE e.value = ?
               )`
          )
          .all(eventName, eventName)) {
          addEventSubscriber(subscribers, row);
        }
        return [...subscribers.values()];
      }),
    insert: (input) =>
      store.write((database) => {
        const now = new Date();
        database
          .prepare(
            `INSERT INTO workflows
             (id, name, description, graph, is_paused, mode, visibility,
              published_version_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
          )
          .run(
            input.id,
            input.name,
            input.description ?? null,
            encodeGraph(input.graph),
            input.isPaused === true ? 1 : 0,
            input.mode ?? "live",
            input.visibility ?? "private",
            now.getTime(),
            now.getTime()
          );
        replaceSubscriptions(database, input.id, input.eventSubscriptions);
        const workflow = findWorkflow(database, input.id);
        if (!workflow) throw new Error("Inserted SQLite workflow is missing");
        return workflow;
      }),
    findPausedById: (workflowId) =>
      store.read((database) => {
        const row = database
          .prepare("SELECT id, is_paused FROM workflows WHERE id = ?")
          .get(workflowId);
        return row
          ? {
              id: requiredString(row, "id"),
              isPaused: requiredBoolean(row, "is_paused"),
            }
          : null;
      }),
    setPaused: ({ workflowId, isPaused }) =>
      store.write((database) => {
        database
          .prepare(
            "UPDATE workflows SET is_paused = ?, updated_at = ? WHERE id = ?"
          )
          .run(isPaused ? 1 : 0, Date.now(), workflowId);
      }),
    update: ({ workflowId, updates, eventSubscriptions }) =>
      store.write((database) => {
        const clauses = ["updated_at = ?"];
        const values: SQLInputValue[] = [updates.updatedAt.getTime()];
        if (updates.name !== undefined) {
          clauses.push("name = ?");
          values.push(updates.name);
        }
        if (updates.description !== undefined) {
          clauses.push("description = ?");
          values.push(updates.description);
        }
        if (updates.graph !== undefined) {
          clauses.push("graph = ?");
          values.push(encodeGraph(updates.graph));
        }
        if (updates.mode !== undefined) {
          clauses.push("mode = ?");
          values.push(updates.mode);
        }
        const changed = database
          .prepare(
            `UPDATE workflows SET ${clauses.join(", ")} WHERE id = ? RETURNING id`
          )
          .get(...values, workflowId);
        if (!changed) return null;
        if (eventSubscriptions !== "unchanged") {
          replaceSubscriptions(database, workflowId, eventSubscriptions);
        }
        return findWorkflow(database, workflowId);
      }),
    deleteById: (workflowId) =>
      store.write((database) => {
        database.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
      }),
    findCurrent: store.read((database) => {
      const row = database
        .prepare(
          "SELECT * FROM workflows WHERE name = ? ORDER BY updated_at DESC LIMIT 1"
        )
        .get(CURRENT_WORKFLOW_NAME);
      return row ? sqliteWorkflow(row) : null;
    }),
    insertCurrent: ({ id, graph }) =>
      store.write((database) => {
        const now = new Date();
        database
          .prepare(
            `INSERT INTO workflows
             (id, name, description, graph, is_paused, mode, visibility,
              published_version_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 'live', 'private', NULL, ?, ?)`
          )
          .run(
            id,
            CURRENT_WORKFLOW_NAME,
            "Auto-saved current workflow",
            encodeGraph(graph),
            now.getTime(),
            now.getTime()
          );
        return findWorkflow(database, id);
      }),
    findLatestVersion: (workflowId) =>
      store.read((database) => {
        const row = database
          .prepare(
            `SELECT version FROM workflow_versions
             WHERE workflow_id = ? AND kind = 'published'
             ORDER BY version DESC LIMIT 1`
          )
          .get(workflowId);
        return row ? { version: requiredNumber(row, "version") } : null;
      }),
    listVersionHistoryPage: ({ workflowId, limit, cursor }) =>
      store.read((database) =>
        database
          .prepare(
            `SELECT v.id, v.version, v.published_at,
                    v.id = w.published_version_id AS is_current
             FROM workflow_versions v
             JOIN workflows w ON w.id = v.workflow_id
             WHERE v.workflow_id = ? AND v.kind = 'published'
               AND (? IS NULL OR v.version < ?)
             ORDER BY v.version DESC
             LIMIT ?`
          )
          .all(
            workflowId,
            cursor?.version ?? null,
            cursor?.version ?? null,
            limit + 1
          )
          .map((row): WorkflowVersionHistoryRow => ({
            id: requiredString(row, "id"),
            version: requiredNumber(row, "version"),
            publishedAt: requiredDate(row, "published_at"),
            isCurrent: requiredBoolean(row, "is_current"),
          }))
      ),
    findVersionById: (versionId) =>
      store.read((database) => {
        const row = database
          .prepare("SELECT * FROM workflow_versions WHERE id = ?")
          .get(versionId);
        return row ? sqliteWorkflowVersion(row) : null;
      }),
    findPublishedVersion: (workflowId) =>
      store.read(
        (database) =>
          publishedPair(database, workflowId)?.publishedVersion ?? null
      ),
    findByIdWithPublishedVersion: (workflowId) =>
      store.read((database) => publishedPair(database, workflowId)),
    findByIdWithPublishedVersionForRun: (workflowId) =>
      store.read((database) => {
        const pair = publishedPair(database, workflowId);
        if (!pair) return null;
        const { id, name, mode, isPaused } = pair.workflow;
        return {
          workflow: { id, name, mode, isPaused },
          publishedVersion: pair.publishedVersion,
        };
      }),
    findByIdWithDraftGraphForRun: (workflowId) =>
      store.read((database) => {
        const workflow = findWorkflow(database, workflowId);
        if (!workflow) return null;
        const { id, name, mode, isPaused } = workflow;
        return {
          workflow: { id, name, mode, isPaused },
          draftGraph: workflow.graph,
        };
      }),
    insertPublishedVersion: (input) =>
      store.write((database) => {
        if (!findWorkflow(database, input.workflowId)) return null;
        const publishedAt = new Date();
        const inserted = database
          .prepare(
            `INSERT INTO workflow_versions
             (id, workflow_id, version, kind, graph, catalog_fingerprint,
              graph_digest, published_at)
             VALUES (?, ?, ?, 'published', ?, ?, ?, ?)
             ON CONFLICT (workflow_id, version) DO NOTHING RETURNING id`
          )
          .get(
            input.versionId,
            input.workflowId,
            input.version,
            encodeGraph(input.graph),
            input.catalogFingerprint,
            input.graphDigest,
            publishedAt.getTime()
          );
        if (!inserted) return stalePublication();
        database
          .prepare(
            `UPDATE workflows SET published_version_id = ?, graph = ?, updated_at = ?
             WHERE id = ? AND published_version_id IS ?`
          )
          .run(
            input.versionId,
            encodeGraph(input.draftGraph),
            Date.now(),
            input.workflowId,
            input.expectedPublishedVersionId
          );
        const changed = database.prepare("SELECT changes() AS changed").get();
        if (changed === undefined || requiredNumber(changed, "changed") === 0) {
          database
            .prepare("DELETE FROM workflow_versions WHERE id = ?")
            .run(input.versionId);
          return findWorkflow(database, input.workflowId)
            ? stalePublication()
            : null;
        }
        replaceSubscriptions(
          database,
          input.workflowId,
          input.eventSubscriptions
        );
        const workflow = findWorkflow(database, input.workflowId);
        const versionRow = database
          .prepare("SELECT * FROM workflow_versions WHERE id = ?")
          .get(input.versionId);
        const version = asPublishedVersion(
          versionRow ? sqliteWorkflowVersion(versionRow) : null
        );
        if (!workflow || !version) {
          throw new Error("Published SQLite version is missing");
        }
        return { workflow, version };
      }),
    freezeDraftSnapshot: (input) =>
      store.write((database) => {
        // The column holds `encodeGraph` output, so an identical graph encodes
        // to identical text and a plain equality finds it.
        //
        // The EXISTS clause is what makes the reuse safe against a concurrent
        // start. A snapshot no Execution references yet is private to the
        // request that inserted it, and that request can still release it if a
        // later gate refuses the start. Reusing such a row would let this run
        // pin an id the other request is about to delete. A referenced row can
        // never be deleted, because `deleteUnreferencedDraftSnapshot` refuses
        // it.
        const graph = encodeGraph(input.graph);
        const existing = database
          .prepare(
            `SELECT * FROM workflow_versions
             WHERE workflow_id = ? AND kind = 'draft_snapshot'
               AND catalog_fingerprint = ? AND graph = ?
               AND EXISTS (
                 SELECT 1 FROM workflow_executions
                 WHERE workflow_version_id = workflow_versions.id
               )
             ORDER BY published_at DESC LIMIT 1`
          )
          .get(input.workflowId, input.catalogFingerprint, graph);
        if (existing) return sqliteWorkflowVersion(existing);

        database
          .prepare(
            `INSERT INTO workflow_versions
             (id, workflow_id, version, kind, graph, catalog_fingerprint,
              graph_digest, published_at)
             VALUES (?, ?, NULL, 'draft_snapshot', ?, ?, ?, ?)`
          )
          .run(
            input.versionId,
            input.workflowId,
            graph,
            input.catalogFingerprint,
            input.graphDigest,
            Date.now()
          );
        const row = database
          .prepare("SELECT * FROM workflow_versions WHERE id = ?")
          .get(input.versionId);
        if (!row) throw new Error("The draft snapshot was not written");
        return sqliteWorkflowVersion(row);
      }),

    deleteUnreferencedDraftSnapshot: (versionId) =>
      store.write((database) => {
        const result = database
          .prepare(
            `DELETE FROM workflow_versions
             WHERE id = ? AND kind = 'draft_snapshot'
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_executions
                 WHERE workflow_version_id = workflow_versions.id
               )`
          )
          .run(versionId);
        return result.changes > 0;
      }),
  };
}
