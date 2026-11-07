/**
 * The draft snapshot slice of `WorkflowRepo` over PostgreSQL: the freeze a
 * Draft run pins, the release a refused start makes, and the run-history
 * sweep. `retention-policy.ts` decides which snapshots the sweep deletes.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Effect } from "effect";
import {
  type WorkflowVersion,
  workflowExecutions,
  workflowVersions,
} from "#src/backend/lib/db/schema";
import { deleteOldestBatch } from "#src/backend/lib/db/batched-delete";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { sweepableDraftSnapshot } from "#src/backend/services/workflows/repo/retention-policy";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

/** The draft snapshot slice of `WorkflowRepo`. */
export type DraftSnapshotRepoMethods = {
  /**
   * Freezes the draft graph as a version a run can pin to, and returns the
   * row. When this workflow already has a snapshot of this exact graph under
   * this catalog, and an Execution already references that snapshot, that row
   * comes back instead of a new one. So `versionId` is a proposal, and the
   * caller pins the returned `id`. Repeated runs of an unchanged canvas share
   * one row from the second run onward. Inserting or reusing a row sets its
   * `lastPinnedAt` to now, which keeps `sweepUnreferencedDraftSnapshots`
   * from deleting it before the caller's Execution is inserted.
   *
   * A snapshot no Execution references yet belongs to the request that
   * inserted it, which can still release it, so this never hands one to
   * another request.
   *
   * The call writes nothing else. It claims no version number and the
   * publication pointer does not move. The Event subscription index keeps
   * describing the published graph, so only a manual start runs a draft.
   */
  readonly freezeDraftSnapshot: (input: {
    workflowId: string;
    versionId: string;
    graph: SerializedWorkflowGraph;
    catalogFingerprint: string;
    graphDigest: string;
  }) => Effect.Effect<WorkflowVersion, DatabaseError>;
  /**
   * Deletes a draft snapshot that no Execution references, and keeps one that
   * an Execution does reference. A start refused after the freeze, such as a
   * first-wins concurrency refusal, calls this so the refusal leaves no row
   * behind. A concurrent start that pinned the same snapshot keeps it.
   * Returns whether a row was deleted.
   */
  readonly deleteUnreferencedDraftSnapshot: (
    versionId: string
  ) => Effect.Effect<boolean, DatabaseError>;
  /**
   * The run-history retention sweep's share of this aggregate: delete up to
   * `limit` draft snapshots that no Execution references and whose
   * `lastPinnedAt` is before `olderThan`, least recently pinned first,
   * answering how many went. A published version is never deleted. Run it
   * after the Executions sweep, which is what leaves a snapshot
   * unreferenced.
   *
   * `freezeDraftSnapshot` hands out a referenced snapshot and the caller
   * inserts the Execution pinning it in a later transaction. The reuse moves
   * `lastPinnedAt` to now, so a snapshot whose last referencing run was
   * swept in between stays until a sweep whose window has passed that
   * reuse.
   */
  readonly sweepUnreferencedDraftSnapshots: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
};

/** Builds the draft snapshot slice of `WorkflowRepo` over one database. */
export function makeDraftSnapshotMethods(
  database: Database["Service"]
): DraftSnapshotRepoMethods {
  return {
    freezeDraftSnapshot: (input) =>
      database.query(async (db) => {
        // jsonb equality is structural, so key order and whitespace in the
        // stored column do not affect the match.
        //
        // The EXISTS clause is what makes the reuse safe against a
        // concurrent start. A snapshot no Execution references yet is
        // private to the request that inserted it, and that request can
        // still release it if a later gate refuses the start. Reusing such
        // a row would let this run pin an id the other request is about to
        // delete. A referenced row can never be deleted, because
        // `deleteUnreferencedDraftSnapshot` refuses it.
        //
        // The reuse moves `last_pinned_at` to now in the same statement,
        // as `sweepUnreferencedDraftSnapshots` describes. When the sweep
        // holds the row and deletes it first, this update matches nothing
        // and a new snapshot is inserted.
        const now = new Date();
        const [existing] = await db
          .update(workflowVersions)
          .set({ lastPinnedAt: now })
          .where(
            inArray(
              workflowVersions.id,
              db
                .select({ id: workflowVersions.id })
                .from(workflowVersions)
                .where(
                  and(
                    eq(workflowVersions.workflowId, input.workflowId),
                    eq(workflowVersions.kind, "draft_snapshot"),
                    eq(
                      workflowVersions.catalogFingerprint,
                      input.catalogFingerprint
                    ),
                    eq(workflowVersions.graph, input.graph),
                    sql`exists (select 1 from ${workflowExecutions} where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id})`
                  )
                )
                .orderBy(desc(workflowVersions.lastPinnedAt))
                .limit(1)
            )
          )
          .returning();
        if (existing) {
          return existing;
        }

        const [snapshot] = await db
          .insert(workflowVersions)
          .values({
            id: input.versionId,
            workflowId: input.workflowId,
            version: null,
            kind: "draft_snapshot",
            graph: input.graph,
            catalogFingerprint: input.catalogFingerprint,
            graphDigest: input.graphDigest,
            lastPinnedAt: now,
          })
          .returning();

        if (!snapshot) {
          throw new Error("The draft snapshot was not written");
        }

        return snapshot;
      }),

    deleteUnreferencedDraftSnapshot: (versionId) =>
      database.query(async (db) => {
        // The NOT EXISTS clause keeps this delete from racing a concurrent
        // pin. That insert holds a share lock on the row, so the delete
        // waits for its transaction and then sees the reference.
        const deleted = await db
          .delete(workflowVersions)
          .where(
            and(
              eq(workflowVersions.id, versionId),
              eq(workflowVersions.kind, "draft_snapshot"),
              sql`not exists (select 1 from ${workflowExecutions} where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id})`
            )
          )
          .returning({ id: workflowVersions.id });
        return deleted.length > 0;
      }),

    sweepUnreferencedDraftSnapshots: (input) =>
      database.query((db) =>
        // The `last_pinned_at` bound is the guard against a concurrent
        // reuse, as the method's contract describes. A reuse still in
        // progress holds the row, which the batch passes by, and one that
        // committed moved the row out of the bound.
        deleteOldestBatch(db, {
          table: workflowVersions,
          id: workflowVersions.id,
          where: sweepableDraftSnapshot(
            workflowVersions,
            {
              table: workflowExecutions,
              workflowVersionId: workflowExecutions.workflowVersionId,
            },
            input.olderThan
          ),
          oldestFirst: workflowVersions.lastPinnedAt,
          limit: input.limit,
        })
      ),
  };
}
