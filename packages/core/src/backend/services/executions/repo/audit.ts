import type { Effect } from "effect";
import type { WorkflowScopedAuditEventType } from "@wfgraph/shared/lifecycle/audit-event-types";
import { workflowExecutionEvents } from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  NewAuditEvent,
  WorkflowExecutionEvent,
} from "#src/backend/services/executions/repo/contracts";
import { toJsonObject } from "@wfgraph/shared/types/json";

/** How far back the audit trail beside a single run is read. */
const EXECUTION_EVENTS_LIMIT = 200;

/**
 * Newest first, by the timestamp and then by the identity sort key.
 *
 * `created_at` defaults from now(), which is the transaction start, so rows a
 * transaction writes together tie on it. `seq` grows with each insert and
 * settles that tie in insertion order. The SQLite reader orders on its rowid
 * for the same reason.
 */
const NEWEST_FIRST = { createdAt: "desc", seq: "desc" } as const;

/** `seq` is a storage detail of the PostgreSQL table, so no row carries it out. */
const EVENT_COLUMNS = { seq: false } as const;

/**
 * How many rows each workflow audit category receives. Each query applies this
 * limit after it filters by event type.
 */
const WORKFLOW_EVENTS_LIMIT = 50;

/** The `workflow_execution_events` slice: a run timeline and workflow-level audit rows. */
export type AuditRepoMethods = {
  /** Append one entry to a run's timeline, or to its workflow's. */
  readonly recordAuditEvent: (
    input: NewAuditEvent
  ) => Effect.Effect<void, DatabaseError>;
  readonly listEvents: (
    executionId: string
  ) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
  /**
   * The latest rows for one workflow audit category. The event-type filter is
   * part of the database query so another category cannot consume this limit.
   */
  readonly listWorkflowEvents: (input: {
    workflowId: string;
    eventType: WorkflowScopedAuditEventType;
  }) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
};

/** Builds the `workflow_execution_events` slice of `ExecutionRepo` over one database. */
export function makeAuditMethods(
  database: Database["Service"]
): AuditRepoMethods {
  return {
    recordAuditEvent: (input) =>
      database.query(async (db) => {
        await db.insert(workflowExecutionEvents).values({
          workflowId: input.workflowId,
          executionId: input.executionId ?? null,
          eventType: input.eventType,
          message: input.message,
          metadata: toJsonObject(input.metadata),
        });
      }),

    listEvents: (executionId) =>
      database.query((db) =>
        db.query.workflowExecutionEvents.findMany({
          where: { executionId },
          columns: EVENT_COLUMNS,
          orderBy: NEWEST_FIRST,
          limit: EXECUTION_EVENTS_LIMIT,
        })
      ),

    listWorkflowEvents: (input) =>
      database.query((db) =>
        db.query.workflowExecutionEvents.findMany({
          where: {
            workflowId: input.workflowId,
            eventType: input.eventType,
          },
          columns: EVENT_COLUMNS,
          orderBy: NEWEST_FIRST,
          limit: WORKFLOW_EVENTS_LIMIT,
        })
      ),
  };
}
