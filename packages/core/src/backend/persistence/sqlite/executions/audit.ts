import { generateId } from "@wfgraph/shared/utils/id";
import { Effect } from "effect";
import { and, desc, eq, inArray } from "drizzle-orm";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "@wfgraph/shared/lifecycle/audit-event-types";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionEvent } from "#src/backend/persistence/sqlite/executions/rows";
import { workflowExecutionEvents } from "#src/backend/persistence/sqlite/schema";

const EXECUTION_EVENTS_LIMIT = 200;
const WORKFLOW_EVENTS_LIMIT = 50;

export function makeSqliteAuditMethods(
  store: SqliteDatabase
): AuditRepoMethods {
  return {
    recordAuditEvent: (input) =>
      store.write((database) =>
        database.insert(workflowExecutionEvents).values({
          id: generateId(),
          workflowId: input.workflowId,
          executionId: input.executionId ?? null,
          eventType: input.eventType,
          message: input.message,
          metadata: encodeJson(toJsonObject(input.metadata)),
          createdAt: Date.now(),
        })
      ),
    listEvents: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionEvents)
          .where(eq(workflowExecutionEvents.executionId, executionId))
          .orderBy(desc(workflowExecutionEvents.createdAt))
          .limit(EXECUTION_EVENTS_LIMIT)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
    listWorkflowEvents: (workflowId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionEvents)
          .where(
            and(
              eq(workflowExecutionEvents.workflowId, workflowId),
              inArray(
                workflowExecutionEvents.eventType,
                WORKFLOW_SCOPED_AUDIT_EVENT_TYPES
              )
            )
          )
          .orderBy(desc(workflowExecutionEvents.createdAt))
          .limit(WORKFLOW_EVENTS_LIMIT)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
  };
}
