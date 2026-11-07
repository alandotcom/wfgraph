/**
 * Which rows the run-history retention sweep deletes from this aggregate,
 * decided once for both backends as `inbox-policy.ts` decides the inbox's.
 * Each backend deletes the rows a predicate accepts in batches, oldest first.
 */

import { type Column, type SQL, type Table, inArray, sql } from "drizzle-orm";
import { TERMINAL_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  type BoundInstant,
  instantOf,
} from "#src/backend/services/executions/repo/release-policy";

/** The event inbox table and its id column, in one backend's schema. */
export type InboxTable = { table: Table; id: Column };

/**
 * Whether the inbox row `deliveryId` names still exists. A redelivery of that
 * row answers from the decisions its first delivery committed, so a row that
 * records one of those decisions is kept while this holds. A null id names no
 * row.
 */
function inboxRowExists(inbox: InboxTable, deliveryId: SQL | Column): SQL {
  return sql`exists (select 1 from ${inbox.table} where ${inbox.id} = ${deliveryId})`;
}

/**
 * Whether the sweep deletes this Execution: it holds a terminal status, it
 * completed before `olderThan`, and the inbox row of the arrival that opened it
 * is gone. An in-flight run is never swept, however old. A run whose inbox row
 * remains, which a `pending` row, a `failed` row a resend reopened, or a row
 * the inbox sweep has not reached yet can each be, is what a redelivery of that
 * row finds by `(workflow_id, delivery_id)` in place of opening a second run.
 */
export function sweepableExecution(
  execution: { status: Column; completedAt: Column; deliveryId: Column },
  inbox: InboxTable,
  olderThan: BoundInstant
): SQL {
  return sql`(${inArray(execution.status, TERMINAL_EXECUTION_STATUSES)} and ${execution.completedAt} < ${instantOf(execution.completedAt, olderThan)} and not ${inboxRowExists(inbox, execution.deliveryId)})`;
}

/**
 * Whether the sweep deletes this audit row: it names no Execution, as a
 * `run_refused` or `cancel_not_delivered` row does, it was written before
 * `olderThan`, and the inbox row its metadata names as `deliveryId` is gone.
 * A row naming an Execution goes with that run by cascade. The Entity
 * admission refusal `findAdmissionRefusal` reads is the row a redelivery
 * answers from, and every row an arrival writes carries that key.
 */
export function sweepableWorkflowAudit(
  event: { executionId: Column; createdAt: Column; metadata: Column },
  inbox: InboxTable,
  olderThan: BoundInstant
): SQL {
  return sql`(${event.executionId} is null and ${event.createdAt} < ${instantOf(event.createdAt, olderThan)} and not ${inboxRowExists(inbox, sql`(${event.metadata} ->> 'deliveryId')`)})`;
}
