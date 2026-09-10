/**
 * These cases cover the wait row: what a park writes, what a re-park may write
 * over, what a claim may take, and what a Migration moves.
 *
 * A second file for one aggregate, because the run cases and the wait cases
 * together ran past a thousand lines. `executions.ts` holds how a run opens,
 * ends, and is read back; this file holds the row a parked run hangs off.
 */

import { describe, expect, it } from "vitest";
import { isNotNil } from "es-toolkit/predicate";
import { Effect } from "effect";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  emptyGraph,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

/**
 * The wake a claim records on the row it takes, which every claim case here
 * passes because a claim writes one.
 */
const EVENT_ARRIVAL = {
  signalType: "wait-resume",
  eventName: "appointment/approved",
  payload: { approved: true },
} as const;

/**
 * Publishes a second version of the seeded workflow, which the Migration cases
 * move a parked run onto.
 */
const publishSecondVersion = Effect.gen(function* () {
  const workflows = yield* WorkflowRepo;
  const draft = yield* workflows.findDraftRevisionById("wf_1");
  yield* workflows.insertPublishedVersion({
    workflowId: "wf_1",
    versionId: "ver_2",
    version: 2,
    expectedPublishedVersionId: "ver_1",
    expectedDraftRevision: draft?.draftRevision ?? 1,
    graph: emptyGraph,
    draftGraph: emptyGraph,
    catalogFingerprint: "catalog",
    graphDigest: "digest-2",
    eventSubscriptions: [],
  });
});

export function describeExecutionWaitConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("wait rows and migration", () => {
    it("fences concurrent claims and keeps sibling waits claimable", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      await seedPublishedWorkflow(database);

      const waitStateIds = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") throw new Error("start refused");
          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "node_1",
            nodeName: "Approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
          });
          if (!wait) throw new Error("wait refused");
          const sibling = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "node_2",
            nodeName: "Escalation",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_2",
            subscribedEvents: ["appointment/approved"],
          });
          if (!sibling) throw new Error("sibling wait refused");
          return {
            executionId: started.execution.id,
            first: wait.waitStateId,
            sibling: sibling.waitStateId,
          };
        })
      );

      const claim = (connection: ConformanceConnection) =>
        connection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.claimWaitingStateById({
              waitStateId: waitStateIds.first,
              eventName: EVENT_ARRIVAL.eventName,
              arrival: EVENT_ARRIVAL,
            });
          })
        );
      const claims = await Promise.all([
        claim(database),
        claim(otherConnection),
      ]);
      const successfulClaims = claims.filter(isNotNil);
      expect(successfulClaims).toHaveLength(1);

      const firstClaim = successfulClaims[0];
      if (!firstClaim) throw new Error("No wait claim succeeded");
      const siblingClaim = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const settled = yield* executions.settleWaitingStateClaim({
            waitStateId: waitStateIds.first,
            claimedAt: firstClaim.claimedAt,
          });
          if (!settled) throw new Error("Claimed wait did not settle");
          yield* executions.markRunning({
            executionId: waitStateIds.executionId,
            workflowVersionId: "ver_1",
          });
          return yield* executions.claimWaitingStateById({
            waitStateId: waitStateIds.sibling,
            eventName: EVENT_ARRIVAL.eventName,
            arrival: EVENT_ARRIVAL,
          });
        })
      );

      expect(siblingClaim).not.toBeNull();
    });

    it("does not park, re-park, list, or resume waits after an Exit claim", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }
          const firstWait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_exit",
            subscribedEvents: [EVENT_ARRIVAL.eventName],
          });
          if (!firstWait) throw new Error("Initial wait was refused");

          yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_condition_not_met",
            nodeId: "checkpoint_1",
          });

          return {
            listed: yield* executions.listWaitsForEvent({
              workflowId: "wf_1",
              eventName: EVENT_ARRIVAL.eventName,
              limit: 10,
            }),
            claimed: yield* executions.claimWaitingStateById({
              waitStateId: firstWait.waitStateId,
              eventName: EVENT_ARRIVAL.eventName,
              arrival: EVENT_ARRIVAL,
            }),
            reparked: yield* executions.reparkWait({
              waitStateId: firstWait.waitStateId,
              workflowVersionId: "ver_1",
              waitType: "event",
              waitUntil: null,
              subscribedEvents: [EVENT_ARRIVAL.eventName],
              resumeToken: "resume_exit_again",
              metadata: {},
            }),
            newlyParked: yield* executions.startWait({
              executionId: started.execution.id,
              workflowId: "wf_1",
              runId: "run_1",
              nodeId: "wait_2",
              nodeName: "Second approval",
              workflowVersionId: "ver_1",
              waitType: "event",
              resumeToken: "resume_exit_2",
              subscribedEvents: [EVENT_ARRIVAL.eventName],
            }),
          };
        })
      );

      expect(result).toEqual({
        listed: [],
        claimed: null,
        reparked: { ok: false, reason: "not_waiting" },
        newlyParked: undefined,
      });
    });

    it("refuses a first park resolved from a version the run has left", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const park = (workflowVersionId: string) =>
            executions.startWait({
              executionId,
              workflowId: "wf_1",
              runId: "run_1",
              nodeId: "wait_1",
              nodeName: "Wait for approval",
              workflowVersionId,
              waitType: "event",
              resumeToken: `resume_${workflowVersionId}`,
              subscribedEvents: ["appointment/approved"],
            });

          // A Migration lands between the body loading ver_1 and this park.
          const first = yield* park("ver_1");
          const migrated = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
          });
          if (!migrated) throw new Error("The migration was refused");

          return {
            beforeTheMigration: first,
            fromTheVersionLeftBehind: yield* park("ver_1"),
            fromThePinnedVersion: yield* park("ver_2"),
            status: yield* executions.findStatusById(executionId),
          };
        })
      );

      expect(result.beforeTheMigration).toBeDefined();
      // No second row, so the retry against the new pointer opens the only park
      // this run holds.
      expect(result.fromTheVersionLeftBehind).toBeUndefined();
      expect(result.fromThePinnedVersion).toBeDefined();
      expect(result.status).toMatchObject({ status: "waiting" });
    });

    it("parks a running run again while it still holds a waiting row", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const park = (nodeId: string, resumeToken: string) =>
            executions.startWait({
              executionId,
              workflowId: "wf_1",
              runId: "run_1",
              nodeId,
              nodeName: nodeId,
              workflowVersionId: "ver_1",
              waitType: "event",
              resumeToken,
              subscribedEvents: ["appointment/approved"],
            });

          const short = yield* park("wait_short", "resume_short");
          const long = yield* park("wait_long", "resume_long");
          if (!short || !long) throw new Error("A park was refused");

          // The short branch resumes and finishes while the long one is parked.
          yield* executions.markRunning({
            executionId,
            workflowVersionId: "ver_1",
          });
          yield* executions.markWaitStatus({
            waitStateId: short.waitStateId,
            status: "resumed",
          });

          const besideAParkedSibling = yield* executions.markWaitingIfParked({
            executionId,
          });
          const parkedAgain = yield* executions.findStatusById(executionId);

          // The long branch resumes too, and now nothing is parked.
          yield* executions.markRunning({
            executionId,
            workflowVersionId: "ver_1",
          });
          yield* executions.markWaitStatus({
            waitStateId: long.waitStateId,
            status: "resumed",
          });

          return {
            besideAParkedSibling,
            parkedAgain,
            withNothingParked: yield* executions.markWaitingIfParked({
              executionId,
            }),
            stillRunning: yield* executions.findStatusById(executionId),
          };
        })
      );

      expect(result.besideAParkedSibling).toBe(true);
      expect(result.parkedAgain).toMatchObject({ status: "waiting" });
      expect(result.withNothingParked).toBe(false);
      expect(result.stillRunning).toMatchObject({ status: "running" });
    });

    it("lists the node ids each of a set of runs has a log row for", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const start = () =>
            executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "manual",
                runMode: "live",
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
            });

          const first = yield* start();
          const second = yield* start();
          const third = yield* start();
          if (
            first.status !== "started" ||
            second.status !== "started" ||
            third.status !== "started"
          ) {
            throw new Error("Start was refused");
          }

          const log = (executionId: string, nodeId: string) =>
            executions.openNodeLog({
              executionId,
              nodeId,
              nodeName: nodeId,
              nodeType: "action",
            });

          // A node with two attempts answers once, and a node still running
          // counts as reached.
          yield* log(first.execution.id, "node_1");
          const retried = yield* log(first.execution.id, "node_1");
          yield* log(first.execution.id, "node_2");
          yield* log(second.execution.id, "node_3");
          yield* executions.closeNodeLog({
            logId: retried,
            status: "error",
            durationMs: 1,
          });

          return {
            firstId: first.execution.id,
            secondId: second.execution.id,
            thirdId: third.execution.id,
            logged: yield* executions.listLoggedNodeIdsForExecutions([
              first.execution.id,
              second.execution.id,
              third.execution.id,
            ]),
            none: yield* executions.listLoggedNodeIdsForExecutions([]),
          };
        })
      );

      expect(result.logged.get(result.firstId)).toEqual(
        new Set(["node_1", "node_2"])
      );
      expect(result.logged.get(result.secondId)).toEqual(new Set(["node_3"]));
      // A run with no node log rows is absent rather than holding an empty set.
      expect(result.logged.has(result.thirdId)).toBe(false);
      expect(result.none.size).toBe(0);
    });

    it("re-parks a wait on its own row rather than opening a second", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const wait = yield* executions.startWait({
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            waitUntil: new Date("2026-01-01T00:00:00.000Z"),
            subscribedEvents: ["appointment/approved"],
            metadata: { waitTimeout: "7d" },
          });
          if (!wait) throw new Error("Wait was refused");

          yield* executions.reparkWait({
            waitStateId: wait.waitStateId,
            workflowVersionId: "ver_1",
            waitType: "event",
            waitUntil: new Date("2026-02-01T00:00:00.000Z"),
            subscribedEvents: ["appointment/rescheduled"],
            resumeToken: "resume_1",
            metadata: { waitTimeout: "30d" },
          });

          return {
            waitStateId: wait.waitStateId,
            parked: yield* executions.listWaitingStates(executionId),
            byOldEvent: yield* executions.listWaitsForEvent({
              workflowId: "wf_1",
              eventName: "appointment/approved",
              limit: 10,
            }),
            byNewEvent: yield* executions.listWaitsForEvent({
              workflowId: "wf_1",
              eventName: "appointment/rescheduled",
              limit: 10,
            }),
            // The token still addresses the same park after the re-park.
            claim: yield* executions.claimWaitingStateByToken({
              resumeToken: "resume_1",
              arrival: EVENT_ARRIVAL,
            }),
          };
        })
      );

      expect(result.parked).toHaveLength(1);
      expect(result.parked[0]).toMatchObject({
        id: result.waitStateId,
        status: "waiting",
        waitUntil: new Date("2026-02-01T00:00:00.000Z"),
        subscribedEvents: ["appointment/rescheduled"],
        metadata: { waitTimeout: "30d" },
      });
      expect(result.byOldEvent).toHaveLength(0);
      expect(result.byNewEvent.map((row) => row.id)).toEqual([
        result.waitStateId,
      ]);
      expect(result.claim?.waitState.id).toBe(result.waitStateId);
    });

    // A run woken by a Migration is still parked as far as the row is concerned
    // until its next park lands. A resume claim in that window takes the row and
    // records what it was about, so the refused re-park has something to read.
    it("refuses a re-park of a row that has left waiting, which records the claim's arrival", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");

          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_2",
            waitUntil: new Date("2026-01-01T00:00:00.000Z"),
            subscribedEvents: ["appointment/approved"],
            metadata: { waitTimeout: "7d" },
          });
          if (!wait) throw new Error("Wait was refused");

          const claim = yield* executions.claimWaitingStateByToken({
            resumeToken: "resume_2",
            arrival: EVENT_ARRIVAL,
          });
          if (!claim) throw new Error("Wait claim was refused");

          return {
            reparked: yield* executions.reparkWait({
              waitStateId: wait.waitStateId,
              workflowVersionId: "ver_1",
              waitType: "event",
              waitUntil: new Date("2026-02-01T00:00:00.000Z"),
              subscribedEvents: ["appointment/rescheduled"],
              resumeToken: "resume_2",
              metadata: { waitTimeout: "30d" },
            }),
            row: yield* executions.findWaitStateById(wait.waitStateId),
          };
        })
      );

      expect(result.reparked).toEqual({ ok: false, reason: "not_waiting" });
      expect(result.row).toMatchObject({
        status: "resuming",
        // The re-park wrote nothing, so the park's own metadata still stands
        // beside the arrival the claim added.
        subscribedEvents: ["appointment/approved"],
        metadata: { waitTimeout: "7d", arrival: EVENT_ARRIVAL },
      });
    });

    it("lists the in-flight runs of one workflow with their pinned version", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      await seedPublishedWorkflow(database, {
        workflowId: "wf_2",
        name: "Reminders",
        versionId: "ver_other",
      });

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const open = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (open.status !== "started") throw new Error("Start was refused");

          const finished = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (finished.status !== "started")
            throw new Error("Start was refused");
          yield* executions.finishRun({
            executionId: finished.execution.id,
            status: "completed",
            output: null,
          });

          // A run of another workflow, to show the list is scoped to one.
          yield* executions.startForEntity({
            execution: {
              workflowId: "wf_2",
              workflowVersionId: "ver_other",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });

          return {
            openId: open.execution.id,
            rows: yield* executions.listInFlightByWorkflow("wf_1"),
          };
        })
      );

      expect(result.rows).toEqual([
        {
          id: result.openId,
          status: "running",
          workflowVersionId: "ver_1",
          versionKind: "published",
          versionNumber: 1,
          entityType: null,
          entityId: null,
        },
      ]);
    });

    it("moves a parked run's version pointer only under both guards", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          const draft = yield* workflows.findDraftRevisionById("wf_1");
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_2",
            version: 2,
            expectedPublishedVersionId: "ver_1",
            expectedDraftRevision: draft?.draftRevision ?? 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest-2",
            eventSubscriptions: [],
          });

          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const whileRunning = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
          });

          const wait = yield* executions.startWait({
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "delay",
            waitUntil: new Date("2026-01-01T00:00:00.000Z"),
          });
          if (!wait) throw new Error("Wait was refused");

          const fromAnotherVersion = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_2",
            toVersionId: "ver_2",
          });
          const whileWaiting = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
          });

          return {
            whileRunning,
            fromAnotherVersion,
            whileWaiting,
            summary: yield* executions.findSummaryById(executionId),
          };
        })
      );

      expect(result.whileRunning).toBe(false);
      expect(result.fromAnotherVersion).toBe(false);
      expect(result.whileWaiting).toBe(true);
      expect(result.summary).toMatchObject({
        workflowVersionId: "ver_2",
        versionNumber: 2,
        status: "waiting",
      });
    });

    it("marks a run running only while it pins the version the caller loaded", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;

          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const wait = yield* executions.startWait({
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "delay",
            waitUntil: new Date("2026-01-01T00:00:00.000Z"),
          });
          if (!wait) throw new Error("Wait was refused");

          const migrated = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
          });
          if (!migrated) throw new Error("The migration was refused");

          return {
            // The resuming body loaded ver_1, which the row no longer pins.
            underTheVersionLeftBehind: yield* executions.markRunning({
              executionId,
              workflowVersionId: "ver_1",
            }),
            underThePinnedVersion: yield* executions.markRunning({
              executionId,
              workflowVersionId: "ver_2",
            }),
            // A sibling Wait of the same run resumes into a row already running.
            fromASiblingWait: yield* executions.markRunning({
              executionId,
              workflowVersionId: "ver_2",
            }),
            status: yield* executions.findStatusById(executionId),
          };
        })
      );

      expect(result.underTheVersionLeftBehind).toBe(false);
      expect(result.underThePinnedVersion).toBe(true);
      expect(result.fromASiblingWait).toBe(true);
      expect(result.status).toMatchObject({ status: "running" });
    });

    it("refuses a re-park resolved from a version the run has left", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;

          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");
          const executionId = started.execution.id;

          const wait = yield* executions.startWait({
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            waitUntil: new Date("2026-01-01T00:00:00.000Z"),
            subscribedEvents: ["appointment/approved"],
            metadata: { waitTimeout: "7d" },
          });
          if (!wait) throw new Error("Wait was refused");

          const migrated = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
          });
          if (!migrated) throw new Error("The migration was refused");

          return {
            fromTheVersionLeftBehind: yield* executions.reparkWait({
              waitStateId: wait.waitStateId,
              workflowVersionId: "ver_1",
              waitType: "event",
              waitUntil: new Date("2026-02-01T00:00:00.000Z"),
              subscribedEvents: ["appointment/rescheduled"],
              resumeToken: "resume_1",
              metadata: { waitTimeout: "30d" },
            }),
            afterTheRefusedWrite: yield* executions.findWaitStateById(
              wait.waitStateId
            ),
            fromThePinnedVersion: yield* executions.reparkWait({
              waitStateId: wait.waitStateId,
              workflowVersionId: "ver_2",
              waitType: "event",
              waitUntil: new Date("2026-02-01T00:00:00.000Z"),
              subscribedEvents: ["appointment/rescheduled"],
              resumeToken: "resume_1",
              metadata: { waitTimeout: "30d" },
            }),
          };
        })
      );

      expect(result.fromTheVersionLeftBehind).toEqual({
        ok: false,
        reason: "version_moved",
      });
      expect(result.afterTheRefusedWrite).toMatchObject({
        status: "waiting",
        subscribedEvents: ["appointment/approved"],
        metadata: { waitTimeout: "7d" },
      });
      expect(result.fromThePinnedVersion).toEqual({ ok: true });
    });

    it("refuses to claim a wait re-parked as a delay", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");

          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
          });
          if (!wait) throw new Error("Wait was refused");

          // The token stays on the row so both claims address it and the wait
          // type is the only thing refusing them.
          const reparked = yield* executions.reparkWait({
            waitStateId: wait.waitStateId,
            workflowVersionId: "ver_1",
            waitType: "delay",
            waitUntil: new Date("2026-02-01T00:00:00.000Z"),
            subscribedEvents: ["appointment/approved"],
            resumeToken: "resume_1",
            metadata: {},
          });
          if (!reparked.ok) throw new Error("The re-park was refused");

          return {
            byId: yield* executions.claimWaitingStateById({
              waitStateId: wait.waitStateId,
              eventName: "appointment/approved",
              arrival: EVENT_ARRIVAL,
            }),
            byToken: yield* executions.claimWaitingStateByToken({
              resumeToken: "resume_1",
              arrival: EVENT_ARRIVAL,
            }),
            row: yield* executions.findWaitStateById(wait.waitStateId),
          };
        })
      );

      expect(result.byId).toBeNull();
      expect(result.byToken).toBeNull();
      expect(result.row).toMatchObject({ status: "waiting" });
    });

    it("refuses to claim a wait no longer subscribed to the delivered event", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started")
            throw new Error("Start was refused");

          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
          });
          if (!wait) throw new Error("Wait was refused");

          const reparked = yield* executions.reparkWait({
            waitStateId: wait.waitStateId,
            workflowVersionId: "ver_1",
            waitType: "event",
            waitUntil: null,
            subscribedEvents: ["appointment/rescheduled"],
            resumeToken: "resume_1",
            metadata: {},
          });
          if (!reparked.ok) throw new Error("The re-park was refused");

          return {
            onTheDroppedEvent: yield* executions.claimWaitingStateById({
              waitStateId: wait.waitStateId,
              eventName: "appointment/approved",
              arrival: EVENT_ARRIVAL,
            }),
            onTheEventItNowNames: yield* executions.claimWaitingStateById({
              waitStateId: wait.waitStateId,
              eventName: "appointment/rescheduled",
              arrival: EVENT_ARRIVAL,
            }),
          };
        })
      );

      expect(result.onTheDroppedEvent).toBeNull();
      expect(result.onTheEventItNowNames?.waitState.id).not.toBeUndefined();
    });

    it("pages waits across run modes and filters the runs a delivery settled", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionIds: string[] = [];
          for (const [suffix, runMode] of [
            ["a", "live"],
            ["b", "test"],
            ["c", "live"],
          ] as const) {
            const started = yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode,
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
            executionIds.push(started.execution.id);
            yield* executions.startWait({
              executionId: started.execution.id,
              workflowId: "wf_1",
              runId: `run_${suffix}`,
              nodeId: "wait_1",
              nodeName: "Wait for approval",
              workflowVersionId: "ver_1",
              waitType: "event",
              resumeToken: `resume_${suffix}`,
              subscribedEvents: ["appointment/approved"],
              metadata: {},
            });
          }

          const firstExecutionId = executionIds[0];
          if (!firstExecutionId) {
            throw new Error("No run was started");
          }

          const query = {
            workflowId: "wf_1",
            eventName: "appointment/approved",
          };
          const firstPage = yield* executions.listWaitsForEvent({
            ...query,
            limit: 2,
          });
          return {
            all: yield* executions.listWaitsForEvent({ ...query, limit: 10 }),
            firstPage,
            secondPage: yield* executions.listWaitsForEvent({
              ...query,
              limit: 2,
              afterId: firstPage.at(-1)?.id,
            }),
            excludingOne: yield* executions.listWaitsForEvent({
              ...query,
              limit: 10,
              excludingExecutionIds: [firstExecutionId],
            }),
            // An empty exclusion has to mean "exclude nothing" rather than reach
            // the database as an empty `in ()`, which is a syntax error there.
            excludingNone: yield* executions.listWaitsForEvent({
              ...query,
              limit: 10,
              excludingExecutionIds: [],
            }),
            otherEvent: yield* executions.listWaitsForEvent({
              ...query,
              eventName: "appointment/other",
              limit: 10,
            }),
            executionIds,
          };
        })
      );

      const ids = result.all.map((wait) => wait.id);
      expect(ids).toEqual(ids.toSorted());
      expect(result.all.map((wait) => wait.executionId).toSorted()).toEqual(
        result.executionIds.toSorted()
      );
      expect(result.firstPage.map((wait) => wait.id)).toEqual(ids.slice(0, 2));
      expect(result.secondPage.map((wait) => wait.id)).toEqual(ids.slice(2));
      expect(result.excludingOne.map((wait) => wait.executionId)).not.toContain(
        result.executionIds[0]
      );
      expect(result.excludingOne).toHaveLength(2);
      expect(result.excludingNone).toHaveLength(3);
      expect(result.otherEvent).toEqual([]);
    });
  });
}
