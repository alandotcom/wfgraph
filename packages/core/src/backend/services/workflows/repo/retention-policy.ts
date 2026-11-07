/**
 * Which rows the run-history retention sweep deletes from this aggregate,
 * decided once for both backends as `executions/repo/retention-policy.ts`
 * decides the run's. Each backend deletes the rows it accepts in batches.
 */

import { type Column, type SQL, type Table, sql } from "drizzle-orm";
import {
  type BoundInstant,
  instantOf,
} from "#src/backend/services/executions/repo/release-policy";

/**
 * Whether the sweep deletes this version: it is a draft snapshot, a Draft run
 * last pinned it before `olderThan`, and no Execution references it. A
 * published version is never swept. The kind is compared to a literal so the
 * planner can match the partial index on draft snapshots.
 */
export function sweepableDraftSnapshot(
  version: { id: Column; kind: Column; lastPinnedAt: Column },
  executions: { table: Table; workflowVersionId: Column },
  olderThan: BoundInstant
): SQL {
  return sql`(${version.kind} = 'draft_snapshot' and ${version.lastPinnedAt} < ${instantOf(version.lastPinnedAt, olderThan)} and not exists (select 1 from ${executions.table} where ${executions.workflowVersionId} = ${version.id}))`;
}
