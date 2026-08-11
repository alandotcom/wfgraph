import { generateId } from "@wfgraph/shared/utils/id";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "@wfgraph/shared/lifecycle/audit-event-types";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  encodeJson,
  placeholders,
} from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionEvent } from "#src/backend/persistence/sqlite/executions/rows";

const EXECUTION_EVENTS_LIMIT = 200;
const WORKFLOW_EVENTS_LIMIT = 50;

export function makeSqliteAuditMethods(
  store: SqliteDatabase
): AuditRepoMethods {
  return {
    recordAuditEvent: (input) =>
      store.write((database) => {
        database
          .prepare(
            `INSERT INTO workflow_execution_events (
               id, workflow_id, execution_id, event_type, message, metadata, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            generateId(),
            input.workflowId,
            input.executionId ?? null,
            input.eventType,
            input.message,
            encodeJson(toJsonObject(input.metadata)),
            Date.now()
          );
      }),
    listEvents: (executionId) =>
      store.read((database) =>
        database
          .prepare(
            `SELECT * FROM workflow_execution_events
             WHERE execution_id = ? ORDER BY created_at DESC
             LIMIT ${EXECUTION_EVENTS_LIMIT}`
          )
          .all(executionId)
          .map(sqliteExecutionEvent)
      ),
    listWorkflowEvents: (workflowId) =>
      store.read((database) =>
        database
          .prepare(
            `SELECT * FROM workflow_execution_events
             WHERE workflow_id = ? AND event_type IN (
               ${placeholders(WORKFLOW_SCOPED_AUDIT_EVENT_TYPES.length)}
             )
             ORDER BY created_at DESC LIMIT ${WORKFLOW_EVENTS_LIMIT}`
          )
          .all(workflowId, ...WORKFLOW_SCOPED_AUDIT_EVENT_TYPES)
          .map(sqliteExecutionEvent)
      ),
  };
}
