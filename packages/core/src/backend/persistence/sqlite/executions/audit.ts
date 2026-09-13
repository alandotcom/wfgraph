import { generateId } from "@wfgraph/shared/utils/id";
import { Effect } from "effect";
import { and, desc, eq, sql } from "drizzle-orm";
import { toJsonObject } from "@wfgraph/shared/types/json";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionEvent } from "#src/backend/persistence/sqlite/executions/rows";
import { workflowExecutionEvents } from "#src/backend/persistence/sqlite/schema";

const EXECUTION_EVENTS_LIMIT = 200;

// `created_at` holds whole milliseconds, and a park followed by its in-place
// resume writes two rows inside one millisecond. The rowid grows with each
// insert, so it breaks the tie in insertion order. The PostgreSQL table settles
// the same tie with a `seq` identity column, which is the column its reader
// orders on after `created_at`; SQLite needs no such column because every table
// here already has a rowid.
const newestFirst = [desc(workflowExecutionEvents.createdAt), desc(sql`rowid`)];
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
          .orderBy(...newestFirst)
          .limit(EXECUTION_EVENTS_LIMIT)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
    listWorkflowEvents: (input) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionEvents)
          .where(
            and(
              eq(workflowExecutionEvents.workflowId, input.workflowId),
              eq(workflowExecutionEvents.eventType, input.eventType)
            )
          )
          .orderBy(...newestFirst)
          .limit(WORKFLOW_EVENTS_LIMIT)
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionEvent)))
      ),
  };
}
