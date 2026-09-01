import { generateId } from "@wfgraph/shared/utils/id";
import { Effect } from "effect";
import { sql } from "drizzle-orm";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "@wfgraph/shared/lifecycle/audit-event-types";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionEvent } from "#src/backend/persistence/sqlite/executions/rows";

const EXECUTION_EVENTS_LIMIT = 200;
const WORKFLOW_EVENTS_LIMIT = 50;

export function makeSqliteAuditMethods(
  store: SqliteDatabase
): AuditRepoMethods {
  return {
    recordAuditEvent: (input) =>
      store.write((database) =>
        database.run(sql`
          insert into workflow_execution_events (
            id, workflow_id, execution_id, event_type, message, metadata, created_at
          ) values (
            ${generateId()}, ${input.workflowId}, ${input.executionId ?? null},
            ${input.eventType}, ${input.message},
            ${encodeJson(toJsonObject(input.metadata))}, ${Date.now()}
          )
        `)
      ),
    listEvents: (executionId) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(sql`
            select * from workflow_execution_events
            where execution_id = ${executionId} order by created_at desc
            limit ${EXECUTION_EVENTS_LIMIT}
          `)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
    listWorkflowEvents: (workflowId) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(sql`
            select * from workflow_execution_events
            where workflow_id = ${workflowId} and event_type in (
              ${sql.join(
                WORKFLOW_SCOPED_AUDIT_EVENT_TYPES.map((type) => sql`${type}`),
                sql`, `
              )}
            )
            order by created_at desc limit ${WORKFLOW_EVENTS_LIMIT}
          `)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
  };
}
