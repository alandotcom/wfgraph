/**
 * These cases cover workflows, their published versions, and how a draft
 * snapshot reads beside them. `draft-snapshots.ts` covers a snapshot's freeze,
 * release and sweep.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { compareText } from "@wfgraph/shared/types/string";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { PersistenceTestRegistry } from "#src/backend/persistence/conformance/support";
import {
  emptyGraph,
  notYetDue,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

export function describeWorkflowConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("workflows", () => {
    it("increments draft revisions and rejects stale graph writes", async () => {
      const database = await openConnection();
      const graph = createSerializedWorkflowGraph({
        nodes: [
          {
            id: "entry",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: {
              type: "lifecycle",
              label: "Lifecycle",
              config: {},
            },
          },
        ],
        edges: [],
      });

      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const inserted = yield* workflows.insert({
            id: "wf_revision",
            name: "Revision workflow",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          const updated = yield* workflows.writeDraft({
            workflowId: inserted.id,
            expectedDraftRevision: inserted.draftRevision,
            updates: { graph, name: "Winner", updatedAt: new Date() },
          });
          const stale = yield* workflows.writeDraft({
            workflowId: inserted.id,
            expectedDraftRevision: inserted.draftRevision,
            updates: {
              graph: emptyGraph,
              name: "Stale",
              updatedAt: new Date(),
            },
          });
          const metadata = yield* workflows.updateMetadata({
            workflowId: inserted.id,
            updates: { description: "Metadata", updatedAt: new Date() },
          });
          return {
            inserted,
            updated,
            stale,
            metadata,
            revision: yield* workflows.findDraftRevisionById(inserted.id),
            missingRevision:
              yield* workflows.findDraftRevisionById("wf_missing"),
            stored: yield* workflows.findById(inserted.id),
          };
        })
      );

      expect(result.inserted.draftRevision).toBe(1);
      expect(result.updated).toMatchObject({
        status: "updated",
        workflow: { draftRevision: 2, name: "Winner" },
      });
      expect(result.stale).toEqual({
        status: "conflict",
        currentDraftRevision: 2,
      });
      expect(result.metadata?.draftRevision).toBe(2);
      expect(result.revision).toEqual({
        id: "wf_revision",
        draftRevision: 2,
      });
      expect(result.missingRevision).toBeNull();
      expect(result.stored).toMatchObject({
        draftRevision: 2,
        name: "Winner",
        description: "Metadata",
        graph,
      });
    });

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
            expectedDraftRevision: 2,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-2",
            eventSubscriptions: [],
            now: new Date(),
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_3",
            version: 3,
            expectedPublishedVersionId: "ver_2",
            expectedDraftRevision: 3,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-3",
            eventSubscriptions: [],
            now: new Date(),
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
              ...notYetDue,
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
            ...notYetDue,
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
            ...notYetDue,
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
            ...notYetDue,
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
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "other-digest",
            eventSubscriptions: [],
            now: new Date(),
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
            ...notYetDue,
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
              ...notYetDue,
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
      // The comparator mirrors the database's own ORDER BY, whose id tie-break
      // is a text collation rather than code-unit order.
      const expected = [usage.first, usage.second].toSorted((left, right) => {
        const byPublishedAt =
          right.publishedAt.getTime() - left.publishedAt.getTime();
        return byPublishedAt === 0
          ? compareText(right.id, left.id)
          : byPublishedAt;
      });
      expect(usage.usage.map((item) => item.id)).toEqual(
        expected.map((snapshot) => snapshot.id)
      );
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
              expectedDraftRevision: version,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "same-graph",
              eventSubscriptions: [],
              now: new Date(),
            });
          }
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_2",
            versionId: "ver_other",
            version: 1,
            expectedPublishedVersionId: null,
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "same-graph",
            eventSubscriptions: [],
            now: new Date(),
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
              expectedDraftRevision: 1,
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
              now: new Date(),
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
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [],
            now: new Date(),
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
              expectedDraftRevision: 1,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "digest",
              eventSubscriptions: [],
              now: new Date(),
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
            expectedDraftRevision: 1,
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
            now: new Date(),
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
              ...notYetDue,
            });
            if (started.status !== "started") {
              throw new Error("Start was refused");
            }
            yield* executions.startWait({
              side: "started",
              executionId: started.execution.id,
              workflowId: "wf_1",
              nodeId: "wait_1",
              nodeName: "Wait for approval",
              workflowVersionId: "ver_1",
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
            expectedDraftRevision: 1,
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
            now: new Date(),
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
            ...notYetDue,
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }
          yield* executions.startWait({
            side: "started",
            executionId: started.execution.id,
            workflowId: "wf_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
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
          yield* workflows.setPaused({
            workflowId: "wf_1",
            isPaused: true,
            now: new Date(),
          });

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

    it("holds a workflow's mode and visibility to their vocabularies", async () => {
      const database = await openDatabase();
      await seedPublishedWorkflow(await database.open());

      await expect(
        database.execute("update workflows set mode = 'staging'")
      ).rejects.toThrow();
      await expect(
        database.execute("update workflows set visibility = 'shared'")
      ).rejects.toThrow();
      await expect(
        database.execute(
          "update workflows set mode = 'test', visibility = 'public'"
        )
      ).resolves.toBeUndefined();
    });

    it("holds an event subscription's role to its vocabulary", async () => {
      const database = await openDatabase();
      await seedPublishedWorkflow(await database.open(), {
        eventSubscriptions: [
          {
            workflowId: "wf_1",
            eventName: "appointment/created",
            role: "start",
            correlationPath: null,
            connectionId: null,
          },
        ],
      });

      await expect(
        database.execute(
          "update workflow_event_subscriptions set role = 'resume'"
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          "update workflow_event_subscriptions set role = 'cancel'"
        )
      ).resolves.toBeUndefined();
    });

    it("refuses to delete the version a workflow publishes, and deletes it with its workflow", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      await expect(
        database.execute("delete from workflow_versions where id = 'ver_1'")
      ).rejects.toThrow();
      const published = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return yield* workflows.findByIdWithPublishedVersion("wf_1");
        })
      );
      expect(published?.publishedVersion?.id).toBe("ver_1");

      await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.deleteById("wf_1");
        })
      );
      expect(
        await database.selectIds("select id from workflow_versions")
      ).toEqual([]);
    });
  });
}
