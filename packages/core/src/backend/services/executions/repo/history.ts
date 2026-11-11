/**
 * Clearing one workflow's run history on PostgreSQL: its runs, and then its
 * workflow-scoped audit rows, `SWEEP_BATCH` rows per transaction. Each batch
 * commits on its own, so a clear that stops partway leaves whole runs behind,
 * and calling it again finishes the job.
 */

import { asc, eq, inArray } from "drizzle-orm";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import { deleteOldestBatch } from "#src/backend/lib/db/batched-delete";
import { lockSchedules } from "#src/backend/services/executions/repo/schedule";
import { SWEEP_BATCH } from "#src/backend/services/executions/repo/retention-policy";

/**
 * Deletes up to `SWEEP_BATCH` runs of `workflowId`, answering how many runs
 * the batch chose and how many it deleted. The two differ when a run sweep
 * deleted a chosen run first. The schedule rows are locked before the
 * execution rows, in the order a pass's fenced write takes them, and the
 * execution rows before the cascade reaches their audit rows, in the order
 * the run sweep takes them. Node logs, wait rows, schedule rows, step memos
 * and run-scoped audit rows go with each run by cascade.
 */
async function deleteRunBatch(
  tx: WfGraphTransaction,
  workflowId: string
): Promise<{ chosen: number; deleted: number }> {
  const chosen = await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.workflowId, workflowId))
    .limit(SWEEP_BATCH);
  const ids = chosen.map((row) => row.id);
  if (ids.length === 0) return { chosen: 0, deleted: 0 };
  await lockSchedules(tx, ids);
  await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.id, ids))
    .orderBy(asc(workflowExecutions.id))
    .for("update");
  const deleted = await tx
    .delete(workflowExecutions)
    .where(inArray(workflowExecutions.id, ids))
    .returning({ id: workflowExecutions.id });
  return { chosen: ids.length, deleted: deleted.length };
}

/**
 * Deletes every run of `workflowId` and then every audit row the workflow
 * still holds, answering how many runs went. The audit rows left once the
 * runs are gone are the ones naming no run, such as a Refused Start's.
 */
export async function deleteWorkflowHistory(
  db: WfGraphDatabase,
  workflowId: string
): Promise<number> {
  let runs = 0;
  for (;;) {
    // eslint-disable-next-line eslint/no-await-in-loop -- each batch is a transaction of its own, so a long history holds no lock for its whole length
    const batch = await db.transaction((tx) => deleteRunBatch(tx, workflowId));
    runs += batch.deleted;
    if (batch.chosen < SWEEP_BATCH) break;
  }
  for (;;) {
    // eslint-disable-next-line eslint/no-await-in-loop -- as above, one bounded statement at a time
    const deleted = await deleteOldestBatch(db, {
      table: workflowExecutionEvents,
      id: workflowExecutionEvents.id,
      where: eq(workflowExecutionEvents.workflowId, workflowId),
      oldestFirst: workflowExecutionEvents.createdAt,
      limit: SWEEP_BATCH,
    });
    if (deleted < SWEEP_BATCH) break;
  }
  return runs;
}
