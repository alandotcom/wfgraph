import type { Effect } from "effect";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "#src/backend/services/executions/workflow-audit";
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
 * How many Refused Starts the panel is given. Lower than the per-run limit above
 * because these are read for the whole workflow and a busy first-wins workflow
 * writes one per arrival it declines.
 */
const WORKFLOW_EVENTS_LIMIT = 50;

/** The `workflow_execution_events` slice of `ExecutionRepo`, a run's timeline and its workflow's. */
export type AuditRepoMethods = {
  /** Append one entry to a run's timeline, or to its workflow's. */
  readonly recordAuditEvent: (
    input: NewAuditEvent
  ) => Effect.Effect<void, DatabaseError>;
  readonly listEvents: (
    executionId: string
  ) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
  /**
   * The Refused Starts: audit rows that belong to the workflow because no run
   * was opened for them. Nothing else can reach them, because every other
   * reader is keyed on an execution id and these have none.
   */
  readonly listWorkflowEvents: (
    workflowId: string
  ) => Effect.Effect<WorkflowExecutionEvent[], DatabaseError>;
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
          orderBy: { createdAt: "desc" },
          limit: EXECUTION_EVENTS_LIMIT,
        })
      ),

    listWorkflowEvents: (workflowId) =>
      database.query((db) =>
        db.query.workflowExecutionEvents.findMany({
          // By type rather than by the absent execution id: the scope is what
          // the type means, and a row is unreadable anywhere else because of
          // it. A null id is the consequence, not the definition.
          where: {
            workflowId,
            eventType: { in: [...WORKFLOW_SCOPED_AUDIT_EVENT_TYPES] },
          },
          orderBy: { createdAt: "desc" },
          limit: WORKFLOW_EVENTS_LIMIT,
        })
      ),
  };
}
