/**
 * These cases cover workflows, their published versions, and their draft
 * snapshots.
 */

import { describe, expect, it } from "vitest";
import { orderBy } from "es-toolkit/array";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { PersistenceTestRegistry } from "#src/backend/persistence/conformance/support";
import {
  emptyGraph,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

export function describeWorkflowConformance({
  openConnection,
}: PersistenceTestRegistry): void {
  describe("workflows", () => {
    it("lists the current and active versions without terminal or foreign runs", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const usage = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_2",
            version: 2,
            expectedPublishedVersionId: "ver_1",
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-2",
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_3",
            version: 3,
            expectedPublishedVersionId: "ver_2",
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-3",
            eventSubscriptions: [],
          });
          const snapshot = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          for (const deliveryId of ["delivery_1", "delivery_2"]) {
            yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: deliveryId,
                deliveryId,
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
            });
          }
          yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_2",
              startSource: "manual",
              runMode: "test",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: snapshot.id,
              startSource: "manual",
              runMode: "test",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });

          // All three terminal outcomes are pinned to the current version. They
          // must not cause that current row to look actively used.
          for (const status of ["completed", "canceled"] as const) {
            yield* executions.insertTerminal({
              workflowId: "wf_1",
              workflowVersionId: "ver_3",
              startSource: "manual",
              runMode: "test",
              input: {},
              status,
            });
          }
          const superseded = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_3",
              startSource: "manual",
              runMode: "test",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (superseded.status !== "started") {
            throw new Error("Start was refused");
          }
          yield* executions.endInFlight({
            executionId: superseded.execution.id,
            status: "superseded",
          });

          yield* workflows.insert({
            id: "wf_other",
            name: "Other workflow",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_other",
            versionId: "ver_other",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "other-digest",
            eventSubscriptions: [],
          });
          yield* executions.startForEntity({
            execution: {
              workflowId: "wf_other",
              workflowVersionId: "ver_other",
              startSource: "manual",
              runMode: "test",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });

          return yield* workflows.listVersionUsage("wf_1");
        })
      );

      expect(usage.map((item) => item.id)).toEqual([
        "ver_3",
        "ver_2",
        "ver_1",
        "ver_snapshot",
      ]);
      expect(usage.map((item) => item.activeRunCount)).toEqual([0, 1, 2, 1]);
      expect(usage[0]).toMatchObject({ isCurrent: true, version: 3 });
      expect(usage[0]?.oldestActiveRunAt).toBeNull();
      expect(usage[3]).toMatchObject({
        isCurrent: false,
        kind: "draft_snapshot",
        version: null,
      });
      expect(usage[3]?.oldestActiveRunAt).toBeInstanceOf(Date);
      expect(usage[2]).toMatchObject({ isCurrent: false, version: 1 });
    });

    it("lists active snapshots of a never-published workflow as non-current", async () => {
      const database = await openConnection();
      const usage = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insert({
            id: "wf_draft",
            name: "Draft only",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          const first = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_draft",
            versionId: "snapshot_a",
            graph: createSerializedWorkflowGraph({
              nodes: [],
              edges: [],
              attributes: { snapshot: "a" },
            }),
            catalogFingerprint: "catalog",
            graphDigest: "draft-a",
          });
          const second = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_draft",
            versionId: "snapshot_z",
            graph: createSerializedWorkflowGraph({
              nodes: [],
              edges: [],
              attributes: { snapshot: "z" },
            }),
            catalogFingerprint: "catalog",
            graphDigest: "draft-z",
          });
          for (const snapshot of [first, second]) {
            yield* executions.startForEntity({
              execution: {
                workflowId: "wf_draft",
                workflowVersionId: snapshot.id,
                startSource: "manual",
                runMode: "test",
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
            });
          }

          return {
            first,
            second,
            usage: yield* workflows.listVersionUsage("wf_draft"),
          };
        })
      );

      expect(usage.usage).toHaveLength(2);
      expect(usage.usage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "snapshot_a",
            kind: "draft_snapshot",
            version: null,
            isCurrent: false,
            activeRunCount: 1,
          }),
          expect.objectContaining({
            id: "snapshot_z",
            kind: "draft_snapshot",
            version: null,
            isCurrent: false,
            activeRunCount: 1,
          }),
        ])
      );
      const expected = orderBy(
        [usage.first, usage.second],
        [
          (snapshot) => snapshot.publishedAt.getTime(),
          (snapshot) => snapshot.id,
        ],
        ["desc", "desc"]
      );
      expect(usage.usage.map((item) => item.id)).toEqual(
        expected.map((snapshot) => snapshot.id)
      );
    });

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

    it("keeps chronological version history per workflow and pages it newest first", async () => {
      const database = await openConnection();
      const history = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insert({
            id: "wf_2",
            name: "Billing",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          for (const version of [1, 2, 3]) {
            yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId: `ver_${version}`,
              version,
              expectedPublishedVersionId:
                version === 1 ? null : `ver_${version - 1}`,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "same-graph",
              eventSubscriptions: [],
            });
          }
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_2",
            versionId: "ver_other",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "same-graph",
            eventSubscriptions: [],
          });

          return {
            all: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 3,
            }),
            afterThree: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 1,
              cursor: { version: 3 },
            }),
            other: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_2",
              limit: 3,
            }),
          };
        })
      );

      expect(history.all.map((version) => version.version)).toEqual([3, 2, 1]);
      expect(history.all.filter((version) => version.isCurrent)).toMatchObject([
        { id: "ver_3", version: 3 },
      ]);
      // The repository returns the one extra row needed to prove a next cursor.
      expect(history.afterThree.map((version) => version.version)).toEqual([
        2, 1,
      ]);
      expect(history.other).toMatchObject([{ id: "ver_other", version: 1 }]);
    });

    it("rolls back a failed version publish with its subscription rewrite", async () => {
      const database = await openConnection();
      await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId: "ver_failed",
              version: 1,
              expectedPublishedVersionId: null,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "graph",
              eventSubscriptions: [
                {
                  workflowId: "wf_1",
                  eventName: "appointment/created",
                  role: "start",
                  correlationPath: null,
                  connectionId: null,
                },
                {
                  workflowId: "wf_1",
                  eventName: "appointment/created",
                  role: "start",
                  correlationPath: null,
                  connectionId: null,
                },
              ],
            });
          })
        )
      ).rejects.toBeDefined();

      const state = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return {
            version: yield* workflows.findVersionById("ver_failed"),
            workflow: yield* workflows.findById("wf_1"),
          };
        })
      );
      expect(state.version).toBeNull();
      expect(state.workflow?.publishedVersionId).toBeNull();
    });

    it("answers the run reads for a published workflow, a draft one, and neither", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_published",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_published",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [],
          });
          // This one is never published, the state a canvas test run is also
          // in: the draft read has to answer it while the published read does
          // not.
          yield* workflows.insert({
            id: "wf_draft",
            name: "Reminders",
            graph: emptyGraph,
            eventSubscriptions: [],
          });

          return {
            published:
              yield* workflows.findByIdWithPublishedVersionForRun(
                "wf_published"
              ),
            draftOnlyPublished:
              yield* workflows.findByIdWithPublishedVersionForRun("wf_draft"),
            draftGraph:
              yield* workflows.findByIdWithDraftGraphForRun("wf_draft"),
            missingPublished:
              yield* workflows.findByIdWithPublishedVersionForRun("wf_missing"),
            missingDraft:
              yield* workflows.findByIdWithDraftGraphForRun("wf_missing"),
            mintedForMissing: yield* workflows.insertPublishedVersion({
              workflowId: "wf_missing",
              versionId: "ver_orphan",
              version: 1,
              expectedPublishedVersionId: null,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "digest",
              eventSubscriptions: [],
            }),
            orphan: yield* workflows.findVersionById("ver_orphan"),
          };
        })
      );

      expect(result.published).toMatchObject({
        workflow: { id: "wf_published" },
        publishedVersion: { id: "ver_1", version: 1 },
      });
      expect(result.draftOnlyPublished).toMatchObject({
        workflow: { id: "wf_draft" },
        publishedVersion: null,
      });
      expect(result.draftGraph).toMatchObject({
        workflow: { id: "wf_draft" },
        draftGraph: emptyGraph,
      });
      expect(result.missingPublished).toBeNull();
      expect(result.missingDraft).toBeNull();
      // A publish against a workflow that is gone answers rather than leaving a
      // version row nothing points at.
      expect(result.mintedForMissing).toBeNull();
      expect(result.orphan).toBeNull();
    });

    // `listEventSubscribers` unions two arms: the subscription index a publish
    // writes, and the waits a run parked.
    it("unions every role one workflow holds for an Event and names it once", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [
              {
                workflowId: "wf_1",
                eventName: "appointment/approved",
                role: "start",
                correlationPath: "data.id",
                connectionId: null,
              },
              {
                workflowId: "wf_1",
                eventName: "appointment/approved",
                role: "cancel",
                correlationPath: null,
                connectionId: null,
              },
            ],
          });

          const executions = yield* ExecutionRepo;
          // Two runs park on the same Event, which is what makes the index read
          // name this workflow twice unless the query says otherwise.
          for (const suffix of ["a", "b"]) {
            const started = yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: `appointment_${suffix}`,
                deliveryId: `delivery_${suffix}`,
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
            });
            if (started.status !== "started") {
              throw new Error("Start was refused");
            }
            yield* executions.startWait({
              executionId: started.execution.id,
              workflowId: "wf_1",
              runId: `run_${suffix}`,
              nodeId: "wait_1",
              nodeName: "Wait for approval",
              waitType: "event",
              resumeToken: `resume_${suffix}`,
              subscribedEvents: ["appointment/approved"],
              metadata: {},
            });
          }

          // A parked run is what makes a workflow wake, not a wait role in
          // the index. This one declares the role and parks nothing.
          yield* workflows.insert({
            id: "wf_declared_only",
            name: "Reminders",
            graph: emptyGraph,
            eventSubscriptions: [
              {
                workflowId: "wf_declared_only",
                eventName: "appointment/approved",
                role: "wait",
                correlationPath: null,
                connectionId: null,
              },
            ],
          });

          return {
            subscribers: yield* workflows.listEventSubscribers(
              "appointment/approved"
            ),
            otherEvent:
              yield* workflows.listEventSubscribers("appointment/other"),
          };
        })
      );

      expect(result.subscribers).toHaveLength(1);
      expect(result.subscribers[0]?.id).toBe("wf_1");
      expect(result.subscribers[0]?.roles.toSorted()).toEqual([
        "cancel",
        "start",
        "wait",
      ]);
      expect(result.otherEvent).toEqual([]);
    });

    it("leaves a paused workflow out of both subscriber reads", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [
              {
                workflowId: "wf_1",
                eventName: "appointment/approved",
                role: "start",
                correlationPath: null,
                connectionId: null,
              },
            ],
          });

          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              runMode: "live",
              entityValue: "appointment_1",
              deliveryId: "delivery_1",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }
          yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
            metadata: {},
          });

          const whileRunning = yield* workflows.listEventSubscribers(
            "appointment/approved"
          );
          // Pausing has to close both arms. A workflow paused mid-run would
          // otherwise keep waking on the wait it already parked.
          yield* workflows.setPaused({ workflowId: "wf_1", isPaused: true });

          return {
            whileRunning,
            whilePaused: yield* workflows.listEventSubscribers(
              "appointment/approved"
            ),
            paused: yield* workflows.findPausedById("wf_1"),
          };
        })
      );

      expect(result.whileRunning).toHaveLength(1);
      expect(result.whilePaused).toEqual([]);
      expect(result.paused).toMatchObject({ id: "wf_1", isPaused: true });
    });
  });
}
