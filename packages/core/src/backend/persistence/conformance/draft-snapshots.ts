/**
 * The workflows aggregate's draft snapshots: how a Draft run's freeze reuses
 * a snapshot a run already pinned, how a refused start releases one, and which
 * snapshots the run-history sweep deletes.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
  CaseDatabase,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  emptyGraph,
  seedPublishedWorkflow,
  setTimestamp,
  terminalEntry,
} from "#src/backend/persistence/conformance/support";
import {
  RETENTION_CUTOFF,
  T0,
  at,
} from "#src/backend/persistence/conformance/schedule-support";

/** A graph of its own for each snapshot, so no freeze reuses another's row. */
function snapshotGraph(name: string) {
  return createSerializedWorkflowGraph({
    nodes: [],
    edges: [],
    attributes: { snapshot: name },
  });
}

/** Freezes the empty graph as a draft snapshot of `wf_1`, proposing `versionId`. */
function freezeEmptyDraft(versionId: string) {
  return Effect.gen(function* () {
    const workflows = yield* WorkflowRepo;
    return yield* workflows.freezeDraftSnapshot({
      workflowId: "wf_1",
      versionId,
      graph: emptyGraph,
      catalogFingerprint: "catalog",
      graphDigest: "draft-digest",
    });
  });
}

/** Inserts a completed draft run of `wf_1` pinned to `versionId`. */
function pinDraftRun(versionId: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    return yield* executions.insertTerminal({
      workflowId: "wf_1",
      workflowVersionId: versionId,
      startSource: "manual",
      runMode: "test",
      input: {},
      status: "completed",
      announcement: terminalEntry,
    });
  });
}

/** Sets one timestamp `column` of the version `versionId` names to `when`. */
function setVersionTimestamp(
  database: CaseDatabase,
  input: {
    versionId: string;
    column: "published_at" | "last_pinned_at";
    when: Date;
  }
): Promise<void> {
  return setTimestamp(database, {
    table: "workflow_versions",
    column: input.column,
    where: `id = '${input.versionId}'`,
    at: input.when,
  });
}

export function describeDraftSnapshotConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("draft snapshots", () => {
    it("keeps a draft snapshot out of the published history", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const snapshot = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          // No run references the first row yet, so it stays private to the
          // request that inserted it and this freeze mints a row of its own.
          const unreferenced = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot_2",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          const executions = yield* ExecutionRepo;
          yield* executions.insertTerminal({
            workflowId: "wf_1",
            workflowVersionId: "ver_snapshot",
            startSource: "manual",
            runMode: "test",
            input: {},
            status: "completed",
            announcement: terminalEntry,
          });

          // A run now references the first row, which puts it beyond the
          // release. The same graph under the same catalog therefore reuses it,
          // and the proposed id gives way to that row's id.
          const reused = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot_3",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          // A run pins the reused row, so the release must keep it. A row no
          // run references is deleted.
          const keptPinned =
            yield* workflows.deleteUnreferencedDraftSnapshot("ver_snapshot");
          const loose = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_loose",
            graph: createSerializedWorkflowGraph({
              nodes: [],
              edges: [],
              attributes: { note: "a different graph" },
            }),
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });
          const droppedLoose = yield* workflows.deleteUnreferencedDraftSnapshot(
            loose.id
          );

          return {
            snapshot,
            unreferenced,
            reused,
            keptPinned,
            droppedLoose,
            looseAfter: yield* workflows.findVersionById(loose.id),
            history: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 10,
            }),
            latest: yield* workflows.findLatestVersion("wf_1"),
            found: yield* workflows.findVersionById("ver_snapshot"),
            published: yield* workflows.findPublishedVersion("wf_1"),
            forRun: yield* workflows.findByIdWithDraftGraphForRun("wf_1"),
          };
        })
      );

      expect(result.snapshot).toMatchObject({
        id: "ver_snapshot",
        version: null,
        kind: "draft_snapshot",
      });
      // The history and the next version number cover published rows only, so
      // a snapshot appears in neither. The engine still reads it by id.
      expect(result.history).toMatchObject([{ id: "ver_1", version: 1 }]);
      expect(result.latest).toEqual({ version: 1 });
      expect(result.unreferenced.id).toBe("ver_snapshot_2");
      expect(result.reused.id).toBe("ver_snapshot");
      expect(result.keptPinned).toBe(false);
      expect(result.droppedLoose).toBe(true);
      expect(result.looseAfter).toBeNull();
      expect(result.found?.kind).toBe("draft_snapshot");
      expect(result.published?.id).toBe("ver_1");
      expect(result.forRun).toMatchObject({
        workflow: { id: "wf_1", mode: "live", isPaused: false },
        draftGraph: emptyGraph,
      });
    });

    it("sweeps draft snapshots no Execution references from before the window, a batch at a time, and never a published version", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          for (const versionId of [
            "snap_oldest",
            "snap_old",
            "snap_young",
            "snap_pinned",
          ]) {
            yield* workflows.freezeDraftSnapshot({
              workflowId: "wf_1",
              versionId,
              graph: snapshotGraph(versionId),
              catalogFingerprint: "catalog",
              graphDigest: versionId,
            });
          }
          yield* pinDraftRun("snap_pinned");
        })
      );
      // Every row was created before the window, so only `last_pinned_at`
      // separates the snapshot a run pinned recently from the ones it sweeps.
      const pinnedAt: readonly (readonly [string, Date])[] = [
        ["snap_oldest", T0],
        ["snap_old", at(1_000)],
        ["snap_pinned", at(2_000)],
        ["snap_young", at(7_200_000)],
      ];
      const timestamps = [
        { versionId: "ver_1", column: "published_at" as const, when: T0 },
        ...pinnedAt.flatMap(([versionId, when]) => [
          { versionId, column: "published_at" as const, when: T0 },
          { versionId, column: "last_pinned_at" as const, when },
        ]),
      ];
      await Promise.all(
        timestamps.map((timestamp) => setVersionTimestamp(database, timestamp))
      );

      const result = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const window = { olderThan: RETENTION_CUTOFF };
          const firstSweep = yield* workflows.sweepUnreferencedDraftSnapshots({
            ...window,
            limit: 1,
          });
          const oldestAfterFirstSweep =
            yield* workflows.findVersionById("snap_oldest");
          const oldAfterFirstSweep =
            yield* workflows.findVersionById("snap_old");
          const sweeps = [
            firstSweep,
            yield* workflows.sweepUnreferencedDraftSnapshots({
              ...window,
              limit: 10,
            }),
            yield* workflows.sweepUnreferencedDraftSnapshots({
              ...window,
              limit: 10,
            }),
          ];
          const kept = yield* Effect.forEach(
            ["ver_1", "snap_old", "snap_young", "snap_pinned"],
            (versionId) =>
              workflows
                .findVersionById(versionId)
                .pipe(Effect.map((version) => version?.id ?? null))
          );
          return {
            sweeps,
            oldestAfterFirstSweep,
            oldAfterFirstSweep: oldAfterFirstSweep?.id ?? null,
            kept,
          };
        })
      );

      expect(result.sweeps).toEqual([1, 1, 0]);
      expect(result.oldestAfterFirstSweep).toBeNull();
      expect(result.oldAfterFirstSweep).toBe("snap_old");
      expect(result.kept).toEqual(["ver_1", null, "snap_young", "snap_pinned"]);
    });

    it("keeps a reused draft snapshot through a sweep that removes its last run, so the run reusing it can pin it", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      const earlierRun = await connection.run(
        Effect.gen(function* () {
          yield* freezeEmptyDraft("snap_shared");
          return yield* pinDraftRun("snap_shared");
        })
      );
      await Promise.all(
        (["published_at", "last_pinned_at"] as const).map((column) =>
          setVersionTimestamp(database, {
            versionId: "snap_shared",
            column,
            when: T0,
          })
        )
      );
      await setTimestamp(database, {
        table: "workflow_executions",
        column: "completed_at",
        where: `id = '${earlierRun.id}'`,
        at: T0,
      });

      // A draft start freezes the canvas, which reuses the snapshot the
      // earlier run pinned, and inserts its own Execution in a later
      // transaction. Both sweeps run in between: the first removes the earlier
      // run, which leaves the snapshot unreferenced.
      const result = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          const reused = yield* freezeEmptyDraft("snap_proposed");
          const window = { olderThan: RETENTION_CUTOFF, limit: 10 };
          const sweptRuns = yield* executions.sweepEndedExecutions(window);
          const sweptSnapshots =
            yield* workflows.sweepUnreferencedDraftSnapshots(window);
          const pinned = yield* pinDraftRun(reused.id);
          return { reused, sweptRuns, sweptSnapshots, pinned };
        })
      );

      expect(result.reused.id).toBe("snap_shared");
      // The reuse records the pin and leaves the row's creation time alone.
      expect(result.reused.publishedAt).toEqual(T0);
      expect(result.reused.lastPinnedAt?.getTime()).toBeGreaterThan(
        RETENTION_CUTOFF.getTime()
      );
      expect(result.sweptRuns).toBe(1);
      expect(result.sweptSnapshots).toBe(0);
      expect(result.pinned.workflowVersionId).toBe("snap_shared");
    });
  });
}
