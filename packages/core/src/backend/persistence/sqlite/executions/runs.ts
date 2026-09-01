import { Effect } from "effect";
import { sql, type SQL } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { RunsRepoMethods } from "#src/backend/services/executions/repo/runs";
import type {
  ExecutionSummary,
  GlobalExecutionRow,
  NewExecution,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  optionalDate,
  optionalJsonObject,
  optionalNumber,
  optionalString,
  placeholders,
  requiredBoolean,
  requiredNumber,
  requiredString,
  requiredVersionKind,
  SQLITE_IN_FLIGHT_EXECUTION_STATUSES,
} from "#src/backend/persistence/sqlite/database";
import {
  sqliteExecution,
  sqliteExecutionListRow,
  sqliteExecutionStatus,
} from "#src/backend/persistence/sqlite/executions/rows";

const WORKFLOW_EXECUTIONS_LIMIT = 50;

/**
 * The columns both run-list queries select, plus the two they join for. Payloads
 * and routing columns the lists never paint stay off this list, so a poll does
 * not pull blobs the panel would discard. The version fields label the graph
 * the run pinned.
 */
const EXECUTION_LIST_SELECT =
  sql.raw(`e.id, e.workflow_id, e.status, e.start_source,
  e.run_mode, e.start_event_name, e.entity_value, e.workflow_run_id,
  e.error, e.started_at, e.waiting_at, e.cancelled_at, e.completed_at,
  e.duration, v.kind AS version_kind, v.version AS version_number`);
/** Every run pins exactly one version, so both list reads join it. */
const PINNED_VERSION_JOIN = sql.raw(
  "join workflow_versions v on v.id = e.workflow_version_id"
);
const IN_FLIGHT = sql.raw(SQLITE_IN_FLIGHT_EXECUTION_STATUSES);
type Row = Record<string, unknown>;

export function insertExecution(
  database: SqliteExecutor,
  input: NewExecution,
  status: WorkflowExecution["status"],
  terminal?: { output?: JsonValue; error?: string }
) {
  return Effect.gen(function* () {
    const id = generateId();
    const now = Date.now();
    const isTerminal =
      status === "completed" || status === "failed" || status === "canceled";
    yield* database.run(sql`
      insert into workflow_executions (
        id, workflow_id, workflow_version_id, status, start_source,
        delivery_id, run_mode, start_event_name, entity_value, input,
        output, error, started_at, cancelled_at, completed_at
      ) values (
        ${id}, ${input.workflowId}, ${input.workflowVersionId}, ${status},
        ${input.startSource}, ${input.deliveryId ?? null}, ${input.runMode},
        ${input.startEventName ?? null}, ${input.entityValue ?? null},
        ${encodeJson(input.input)}, ${encodeJson(terminal?.output)},
        ${terminal?.error ?? null}, ${now},
        ${status === "canceled" ? now : null}, ${isTerminal ? now : null}
      )
    `);
    const row = yield* database.get<Row>(
      sql`select * from workflow_executions where id = ${id}`
    );
    if (!row) throw new Error("SQLite did not return the inserted execution");
    return sqliteExecution(row);
  });
}

function executionSummary(row: Row): ExecutionSummary {
  const execution = sqliteExecution(row);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowVersionId: execution.workflowVersionId,
    versionKind: requiredVersionKind(row, "version_kind"),
    versionNumber: optionalNumber(row, "version_number"),
    status: execution.status,
    startSource: execution.startSource,
    runMode: execution.runMode,
    startEventName: execution.startEventName,
    entityValue: execution.entityValue,
    input: execution.input,
    output: execution.output,
    error: execution.error,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    duration: execution.duration,
  };
}

function globalExecution(row: Row): GlobalExecutionRow {
  return {
    ...sqliteExecutionListRow(row),
    workflowName: requiredString(row, "workflow_name"),
    workflowIsPaused: requiredBoolean(row, "workflow_is_paused"),
  };
}

export function makeSqliteRunsMethods(store: SqliteDatabase): RunsRepoMethods {
  return {
    listByWorkflow: ({ workflowId, includeSuperseded }) =>
      store.read((database) =>
        database
          .all<Row>(sql`
            select ${EXECUTION_LIST_SELECT}
            from workflow_executions e ${PINNED_VERSION_JOIN}
            where e.workflow_id = ${workflowId}
              ${includeSuperseded ? sql.empty() : sql`and e.status <> 'superseded'`}
            order by e.started_at desc, e.id desc limit ${WORKFLOW_EXECUTIONS_LIMIT}
          `)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionListRow)))
      ),
    countSuperseded: (workflowId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select count(*) as total from workflow_executions
            where workflow_id = ${workflowId} and status = 'superseded'
          `)
          .pipe(
            Effect.map((row) => {
              if (!row) throw new Error("Invalid SQLite count");
              return requiredNumber(row, "total");
            })
          )
      ),
    listPage: (query) =>
      store.read((database) => {
        const filters: SQL[] = [];
        if (query.workflowIds?.length) {
          filters.push(
            sql`e.workflow_id in (${placeholders(query.workflowIds)})`
          );
        }
        if (query.statuses?.length) {
          filters.push(sql`e.status in (${placeholders(query.statuses)})`);
        }
        if (query.cursor) {
          const startedAt = query.cursor.startedAt.getTime();
          filters.push(sql`(
            e.started_at < ${startedAt}
            or (e.started_at = ${startedAt} and e.id < ${query.cursor.id})
          )`);
        }
        return database
          .all<Row>(sql`
            select ${EXECUTION_LIST_SELECT}, w.name as workflow_name,
              w.is_paused as workflow_is_paused
            from workflow_executions e join workflows w on w.id = e.workflow_id
            ${PINNED_VERSION_JOIN}
            ${filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql.empty()}
            order by e.started_at desc, e.id desc limit ${query.limit}
          `)
          .pipe(Effect.map((rows) => rows.map(globalExecution)));
      }),
    findSummaryById: (executionId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select e.*, v.kind as version_kind, v.version as version_number
            from workflow_executions e ${PINNED_VERSION_JOIN}
            where e.id = ${executionId}
          `)
          .pipe(Effect.map((row) => (row ? executionSummary(row) : null)))
      ),
    findStatusById: (executionId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select id, status from workflow_executions where id = ${executionId}
          `)
          .pipe(
            Effect.map((row) =>
              row
                ? {
                    id: requiredString(row, "id"),
                    status: sqliteExecutionStatus(
                      requiredString(row, "status")
                    ),
                  }
                : null
            )
          )
      ),
    existsById: (executionId) =>
      store.read((database) =>
        database
          .get<Row>(
            sql`select 1 from workflow_executions where id = ${executionId}`
          )
          .pipe(Effect.map(Boolean))
      ),
    findWorkflowIdById: (executionId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select workflow_id from workflow_executions where id = ${executionId}
          `)
          .pipe(
            Effect.map((row) =>
              row ? requiredString(row, "workflow_id") : null
            )
          )
      ),
    insertTerminal: (input) =>
      store.write((database) =>
        insertExecution(database, input, input.status, input)
      ),
    markEnqueued: ({ executionId, runId }) =>
      store.write((database) =>
        database.run(sql`
          update workflow_executions set workflow_run_id = ${runId},
            enqueued_at = ${Date.now()} where id = ${executionId}
        `)
      ),
    markEnqueueFailed: ({ executionId, error }) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update workflow_executions set status = 'failed', error = ${error},
              completed_at = ${Date.now()}, waiting_at = null
            where id = ${executionId} and status in (${IN_FLIGHT}) returning id
          `)
          .pipe(Effect.map(Boolean))
      ),
    markRunning: (executionId) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update workflow_executions set status = 'running', waiting_at = null
            where id = ${executionId} and status = 'waiting' returning id
          `)
          .pipe(Effect.map(Boolean))
      ),
    endInFlight: (input) =>
      store.write((database) => {
        const now = Date.now();
        return database
          .get<Row>(sql`
            update workflow_executions set status = ${input.status},
              waiting_at = null,
              cancelled_at = ${input.status === "canceled" ? now : null},
              completed_at = ${now}, error = ${input.error ?? null}
            where id = ${input.executionId} and status in (${IN_FLIGHT})
            returning id
          `)
          .pipe(Effect.map(Boolean));
      }),
    requestCancelForEntity: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const rows = yield* database.all<Row>(sql`
            select id from workflow_executions
            where workflow_id = ${input.workflowId}
              and entity_value = ${input.entityValue} and run_mode = ${input.runMode}
              and status in (${IN_FLIGHT}) and cancel_requested_at is null
          `);
          yield* database.run(sql`
            update workflow_executions set cancel_requested_at = ${Date.now()},
              cancel_event_name = ${input.eventName},
              cancel_payload = ${encodeJson(input.payload)}
            where workflow_id = ${input.workflowId}
              and entity_value = ${input.entityValue} and run_mode = ${input.runMode}
              and status in (${IN_FLIGHT}) and cancel_requested_at is null
          `);
          return rows.map((row) => requiredString(row, "id"));
        })
      ),
    findPendingCancel: (executionId) =>
      store.read((database) =>
        database
          .get<Row>(sql`
            select cancel_requested_at, cancel_event_name, cancel_payload
            from workflow_executions where id = ${executionId}
          `)
          .pipe(
            Effect.map((row) => {
              if (!row || optionalDate(row, "cancel_requested_at") === null) {
                return null;
              }
              return {
                eventName: optionalString(row, "cancel_event_name"),
                payload: optionalJsonObject(row, "cancel_payload"),
              };
            })
          )
      ),
    finishRun: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const row = yield* database.get<Row>(sql`
            select started_at from workflow_executions where id = ${input.executionId}
          `);
          if (!row) return false;
          const startedAt = requiredNumber(row, "started_at");
          const now = Date.now();
          const updated = yield* database.get<Row>(sql`
            update workflow_executions set status = ${input.status},
              output = ${encodeJson(input.output)}, error = ${input.error ?? null},
              waiting_at = null, completed_at = ${now},
              duration = ${String(now - startedAt)}
            where id = ${input.executionId} and status in (${IN_FLIGHT})
            returning id
          `);
          return Boolean(updated);
        })
      ),
  };
}
