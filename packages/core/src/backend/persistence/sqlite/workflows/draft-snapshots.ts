/**
 * The draft snapshot slice of the SQLite `WorkflowRepo`, as
 * `DraftSnapshotRepoMethods` in `services/workflows/repo/draft-snapshots.ts`
 * describes it. Each method is one `BEGIN IMMEDIATE` write.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DraftSnapshotRepoMethods } from "#src/backend/services/workflows/repo/draft-snapshots";
import { sweepableDraftSnapshot } from "#src/backend/services/workflows/repo/retention-policy";
import {
  type SqliteDatabase,
  encodeGraph,
} from "#src/backend/persistence/sqlite/database";
import { deleteOldestBatch } from "#src/backend/persistence/sqlite/batched-delete";
import {
  workflowExecutions,
  workflowVersions,
} from "#src/backend/persistence/sqlite/schema";
import { sqliteWorkflowVersion } from "#src/backend/persistence/sqlite/workflows/rows";

/** Builds the draft snapshot slice of the SQLite `WorkflowRepo`. */
export function makeSqliteDraftSnapshotMethods(
  store: SqliteDatabase
): DraftSnapshotRepoMethods {
  return {
    freezeDraftSnapshot: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          // Identical graphs encode to identical text and have equal digests,
          // so the digest narrows the candidates through
          // `versions_draft_snapshot_digest_idx` before any graph text is
          // compared. Reuse only a snapshot an
          // Execution already references: an unreferenced snapshot is private
          // to another start that may still delete it after a refused gate.
          // The reuse moves `last_pinned_at` to now in the same statement, as
          // `WorkflowRepo.sweepUnreferencedDraftSnapshots` describes.
          const graph = encodeGraph(input.graph);
          const now = Date.now();
          const existing = yield* database
            .update(workflowVersions)
            .set({ lastPinnedAt: now })
            .where(
              inArray(
                workflowVersions.id,
                database
                  .select({ id: workflowVersions.id })
                  .from(workflowVersions)
                  .where(
                    and(
                      eq(workflowVersions.workflowId, input.workflowId),
                      eq(workflowVersions.kind, "draft_snapshot"),
                      eq(workflowVersions.graphDigest, input.graphDigest),
                      eq(
                        workflowVersions.catalogFingerprint,
                        input.catalogFingerprint
                      ),
                      eq(workflowVersions.graph, graph),
                      sql`exists (
                        select 1 from ${workflowExecutions}
                        where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id}
                      )`
                    )
                  )
                  .orderBy(desc(workflowVersions.lastPinnedAt))
                  .limit(1)
              )
            )
            .returning()
            .get();
          if (existing) return sqliteWorkflowVersion(existing);
          yield* database.insert(workflowVersions).values({
            id: input.versionId,
            workflowId: input.workflowId,
            version: null,
            kind: "draft_snapshot",
            graph,
            catalogFingerprint: input.catalogFingerprint,
            graphDigest: input.graphDigest,
            publishedAt: now,
            lastPinnedAt: now,
          });
          const row = yield* database
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.id, input.versionId))
            .get();
          if (!row) throw new Error("The draft snapshot was not written");
          return sqliteWorkflowVersion(row);
        })
      ),
    deleteUnreferencedDraftSnapshot: (versionId) =>
      store.write((database) =>
        database
          .delete(workflowVersions)
          .where(
            and(
              eq(workflowVersions.id, versionId),
              eq(workflowVersions.kind, "draft_snapshot"),
              sql`not exists (
                select 1 from ${workflowExecutions}
                where ${workflowExecutions.workflowVersionId} = ${workflowVersions.id}
              )`
            )
          )
          .returning({ id: workflowVersions.id })
          .get()
          .pipe(Effect.map(Boolean))
      ),
    sweepUnreferencedDraftSnapshots: (input) =>
      store.write((database) =>
        deleteOldestBatch(database, {
          table: workflowVersions,
          id: workflowVersions.id,
          where: sweepableDraftSnapshot(
            workflowVersions,
            {
              table: workflowExecutions,
              workflowVersionId: workflowExecutions.workflowVersionId,
            },
            input.olderThan.getTime()
          ),
          oldestFirst: workflowVersions.lastPinnedAt,
          limit: input.limit,
        })
      ),
  };
}
