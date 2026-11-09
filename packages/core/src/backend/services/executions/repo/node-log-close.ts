/**
 * The node log close rule, one for both backends: which row statuses a close
 * applies to, checked in code by a pass's store and in SQL by every close, and
 * the `retries` count a close that applies writes.
 */

import { type Column, inArray, type SQL, sql, type Table } from "drizzle-orm";
import type { NodeLogStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { CloseNodeLogInput } from "#src/backend/services/executions/repo/node-logs";
import { nodeRetries } from "#src/backend/services/executions/repo/release-policy";

/**
 * The row statuses a close applies to, by the status the close writes: a
 * `success` corrects an `error` an earlier attempt wrote, a second `error`
 * leaves the first, and nothing overwrites a success.
 */
const NODE_LOG_CLOSABLE: Record<
  CloseNodeLogInput["status"],
  readonly NodeLogStatus[]
> = {
  success: ["running", "error"],
  error: ["running"],
};

/**
 * Whether a close writing `close` applies to a row whose status is `row`.
 * `nodeLogCloseGuard` is the same rule as a WHERE condition.
 */
export function nodeLogCloseApplies(
  row: NodeLogStatus,
  close: CloseNodeLogInput["status"]
): boolean {
  return NODE_LOG_CLOSABLE[close].includes(row);
}

/**
 * The condition every node log close adds to its WHERE, fenced or not. A
 * close the condition refuses changes no column and writes no row version.
 */
export function nodeLogCloseGuard(input: {
  logs: { status: Column };
  close: CloseNodeLogInput["status"];
}): SQL {
  return inArray(input.logs.status, [...NODE_LOG_CLOSABLE[input.close]]);
}

/** The tables `nodeLogCloseRetries` reads, as each backend declares them. */
type NodeLogRetriesTables = {
  logs: { executionId: Column; nodeId: Column; retries: Column };
  schedule: Table & { id: Column; executionId: Column };
  steps: Table & {
    status: Column;
    failures: Column;
    scheduleId: Column;
    nodeId: Column;
  };
};

/**
 * The `retries` a close that applies writes: `nodeRetries` over the memo rows
 * of the row's run that carry the row's node id, or the count the row already
 * holds when the run has none, as after the run ended.
 */
export function nodeLogCloseRetries(tables: NodeLogRetriesTables): SQL {
  const { logs, schedule, steps } = tables;
  return sql`coalesce((select ${nodeRetries(steps)} from ${steps} inner join ${schedule} on ${schedule.id} = ${steps.scheduleId} where ${schedule.executionId} = ${logs.executionId} and ${steps.nodeId} = ${logs.nodeId}), ${logs.retries})`;
}
