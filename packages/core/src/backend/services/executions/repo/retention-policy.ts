/**
 * Which rows the run-history retention sweep deletes from this aggregate,
 * decided once for both backends as `inbox-policy.ts` decides the inbox's.
 * Each backend deletes the rows a predicate accepts in batches, oldest first.
 */

import { type Column, type SQL, inArray, sql } from "drizzle-orm";
import { TERMINAL_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  type BoundInstant,
  instantOf,
} from "#src/backend/services/executions/repo/release-policy";

/**
 * Whether the sweep deletes this Execution: it holds a terminal status and
 * completed before `olderThan`. An in-flight run is never swept, however old.
 */
export function sweepableExecution(
  execution: { status: Column; completedAt: Column },
  olderThan: BoundInstant
): SQL {
  return sql`(${inArray(execution.status, TERMINAL_EXECUTION_STATUSES)} and ${execution.completedAt} < ${instantOf(execution.completedAt, olderThan)})`;
}

/**
 * Whether the sweep deletes this audit row: it names no Execution, as a
 * `run_refused` or `cancel_not_delivered` row does, and it was written before
 * `olderThan`. A row naming an Execution goes with that run by cascade.
 */
export function sweepableWorkflowAudit(
  event: { executionId: Column; createdAt: Column },
  olderThan: BoundInstant
): SQL {
  return sql`(${event.executionId} is null and ${event.createdAt} < ${instantOf(event.createdAt, olderThan)})`;
}
