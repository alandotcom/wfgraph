/**
 * These cases cover runs: how they open, park, resume, cancel, and are read
 * back.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  attemptStart,
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

/** The first-wins start that the race cases in this file make. */
const startFirstWins = (
  connection: ConformanceConnection,
  deliveryId: string
) => attemptStart(connection, { deliveryId, concurrency: "first-wins" });

export function describeExecutionConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("executions, waits and audit", () => {
    it("persists repository state across app lifetimes", async () => {
      const store = await openDatabase();
      const first = await store.open();

      await first.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "Refused",
            metadata: { createdAt: "host-json-stays-a-string" },
          });
        })
      );
      await first.close();

      const second = await store.open();
      const state = await second.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          return {
            workflow: yield* workflows.findById("wf_1"),
            events: yield* executions.listWorkflowEvents({
              workflowId: "wf_1",
              eventType: "run_refused",
            }),
          };
        })
      );

      expect(state.workflow?.name).toBe("Appointments");
      expect(state.events[0]?.metadata).toEqual({
        createdAt: "host-json-stays-a-string",
      });
    });

    it("serializes first-wins starts and makes delivery retries idempotent", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      await seedPublishedWorkflow(database);

      const [first, second] = await Promise.all([
        startFirstWins(database, "delivery_1"),
        startFirstWins(otherConnection, "delivery_2"),
      ]);
      expect([first.status, second.status].toSorted()).toEqual([
        "refused",
        "started",
      ]);

      const started = first.status === "started" ? first : second;
      if (started.status !== "started") {
        throw new Error("Neither start opened a run");
      }
      const retry = await startFirstWins(
        otherConnection,
        first.status === "started" ? "delivery_1" : "delivery_2"
      );
      expect(retry.status).toBe("started");
      if (retry.status !== "started") {
        throw new Error("The replayed delivery was refused");
      }
      expect(retry.execution.id).toBe(started.execution.id);
    });

    it("keeps a durable Entity admission refusal authoritative on replay", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      const decisionId = "admission_refusal_first";

      const refusal = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.recordAdmissionRefusal({
            workflowId: "wf_1",
            deliveryId: "delivery_refusal_first",
            decisionId,
            reason: "entity_condition_not_met",
            message: "Entity Eligibility refused the start",
            metadata: { reason: "entity_condition_not_met" },
          });
        })
      );
      const replay = await attemptStart(database, {
        deliveryId: "delivery_refusal_first",
        entityType: "appointment",
        entityId: "appt_8813",
        admissionDecisionId: decisionId,
      });

      expect(refusal).toEqual({
        kind: "refused",
        reason: "entity_condition_not_met",
      });
      expect(replay).toEqual({
        status: "admission_refused",
        reason: "entity_condition_not_met",
      });
    });

    it("returns an existing start to a racing admission refusal", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      const decisionId = "admission_start_first";
      const started = await attemptStart(database, {
        deliveryId: "delivery_start_first",
        entityType: "appointment",
        entityId: "appt_8813",
        admissionDecisionId: decisionId,
      });
      if (started.status !== "started") {
        throw new Error("The admission did not open a run");
      }

      const decision = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.recordAdmissionRefusal({
            workflowId: "wf_1",
            deliveryId: "delivery_start_first",
            decisionId,
            reason: "entity_not_found",
            message: "Entity Eligibility refused the start",
            metadata: { reason: "entity_not_found" },
          });
        })
      );

      expect(decision).toEqual({
        kind: "started",
        executionId: started.execution.id,
      });
      const refusals = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listWorkflowEvents({
            workflowId: "wf_1",
            eventType: "run_refused",
          });
        })
      );
      expect(refusals).toEqual([]);
    });

    it("finds the Execution a delivery opened by its delivery id", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      const started = await attemptStart(database, {
        deliveryId: "delivery_lookup",
        entityType: "appointment",
        entityId: "appt_8813",
        admissionDecisionId: "admission_lookup",
      });
      if (started.status !== "started") {
        throw new Error("The delivery did not open a run");
      }

      const found = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return {
            own: yield* executions.findByDelivery({
              workflowId: "wf_1",
              deliveryId: "delivery_lookup",
            }),
            unknown: yield* executions.findByDelivery({
              workflowId: "wf_1",
              deliveryId: "delivery_never_started",
            }),
            otherWorkflow: yield* executions.findByDelivery({
              workflowId: "wf_other",
              deliveryId: "delivery_lookup",
            }),
          };
        })
      );

      expect(found.own).toMatchObject({
        id: started.execution.id,
        workflowId: "wf_1",
        deliveryId: "delivery_lookup",
        entityType: "appointment",
        entityId: "appt_8813",
        runMode: "live",
      });
      expect(found.unknown).toBeNull();
      expect(found.otherWorkflow).toBeNull();
    });

    it("settles a concurrent admission start/refusal race once", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      await seedPublishedWorkflow(database);
      const decisionId = "admission_race";

      const [start, refusal] = await Promise.all([
        attemptStart(database, {
          deliveryId: "delivery_admission_race",
          entityType: "appointment",
          entityId: "appt_8813",
          admissionDecisionId: decisionId,
        }),
        otherConnection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.recordAdmissionRefusal({
              workflowId: "wf_1",
              deliveryId: "delivery_admission_race",
              decisionId,
              reason: "entity_condition_not_met",
              message: "Entity Eligibility refused the start",
              metadata: { reason: "entity_condition_not_met" },
            });
          })
        ),
      ]);

      if (start.status === "started") {
        expect(refusal).toEqual({
          kind: "started",
          executionId: start.execution.id,
        });
      } else {
        expect(start).toEqual({
          status: "admission_refused",
          reason: "entity_condition_not_met",
        });
        expect(refusal).toEqual({
          kind: "refused",
          reason: "entity_condition_not_met",
        });
      }
    });

    it("persists typed Entity identity and makes an Exit claim authoritative", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      await seedPublishedWorkflow(database);

      const started = await attemptStart(database, {
        deliveryId: "delivery_entity_exit",
        entityValue: "legacy-correlation",
        entityType: "appointment",
        entityId: "appt_8813",
        concurrency: "first-wins",
      });
      if (started.status !== "started") {
        throw new Error("The Entity-bound run was refused");
      }

      expect(started.execution).toMatchObject({
        entityValue: "legacy-correlation",
        entityType: "appointment",
        entityId: "appt_8813",
      });

      const replay = await attemptStart(otherConnection, {
        deliveryId: "delivery_entity_exit",
        entityValue: "different-retry-value",
        entityType: "different-retry-type",
        entityId: "different-retry-id",
      });
      expect(replay.status).toBe("started");
      if (replay.status !== "started") {
        throw new Error("The delivery replay was refused");
      }
      expect(replay.execution).toMatchObject({
        id: started.execution.id,
        entityValue: "legacy-correlation",
        entityType: "appointment",
        entityId: "appt_8813",
      });

      const competing = await attemptStart(otherConnection, {
        deliveryId: "delivery_same_typed_entity",
        entityValue: "different-legacy-correlation",
        entityType: "appointment",
        entityId: "appt_8813",
        concurrency: "first-wins",
      });
      expect(competing).toMatchObject({
        status: "refused",
        inFlightExecutionIds: [started.execution.id],
      });

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const admittedBeforeExit = yield* executions.canAdmitNode(
            started.execution.id
          );
          const first = yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_condition_not_met",
            nodeId: "node_check_1",
            requestedAt: new Date("2026-10-19T15:00:00.000Z"),
          });
          const admittedAfterExit = yield* executions.canAdmitNode(
            started.execution.id
          );
          const replayed = yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_not_found",
            nodeId: "node_check_2",
          });
          const cancel = yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityType: "appointment",
            entityId: "appt_8813",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: {},
          });
          const completion = yield* executions.finishRun({
            executionId: started.execution.id,
            status: "completed",
            output: { shouldNotPersist: true },
          });
          const exited = yield* executions.finishRun({
            executionId: started.execution.id,
            status: "exited",
          });
          const repeatedExit = yield* executions.finishRun({
            executionId: started.execution.id,
            status: "exited",
          });
          const afterTerminal = yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_not_found",
            nodeId: "node_check_3",
          });
          return {
            admittedBeforeExit,
            admittedAfterExit,
            first,
            replayed,
            cancel,
            completion,
            exited,
            repeatedExit,
            afterTerminal,
            summary: yield* executions.findSummaryById(started.execution.id),
            inFlight: yield* executions.listInFlightByWorkflow("wf_1"),
          };
        })
      );

      const expectedClaim = {
        kind: "exit",
        requestedAt: new Date("2026-10-19T15:00:00.000Z"),
        reason: "entity_condition_not_met",
        nodeId: "node_check_1",
      } as const;
      expect(result.admittedBeforeExit).toBe(true);
      expect(result.admittedAfterExit).toBe(false);
      expect(result.first).toMatchObject({
        executionId: started.execution.id,
        status: "running",
        claim: expectedClaim,
        didWrite: true,
      });
      expect(result.replayed).toMatchObject({
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.cancel).toEqual([]);
      expect(result.completion).toMatchObject({
        status: "running",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.exited).toMatchObject({
        status: "exited",
        claim: expectedClaim,
        didWrite: true,
      });
      expect(result.repeatedExit).toMatchObject({
        status: "exited",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.afterTerminal).toMatchObject({
        status: "exited",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.summary).toMatchObject({
        status: "exited",
        output: null,
      });
      expect(result.inFlight).toEqual([]);

      const terminalReplay = await attemptStart(database, {
        deliveryId: "delivery_entity_exit",
        entityValue: "ignored-after-first-delivery",
      });
      expect(terminalReplay.status).toBe("started");
      if (terminalReplay.status !== "started") {
        throw new Error("The terminal delivery replay was refused");
      }
      expect(terminalReplay.execution).toMatchObject({
        status: "exited",
        cancelledAt: null,
        entityType: "appointment",
        entityId: "appt_8813",
      });
    });

    it("keeps a Cancel claim when Exit races it", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      const started = await attemptStart(database, {
        deliveryId: "delivery_cancel_exit",
        entityValue: "appointment_1",
        entityType: "appointment",
        entityId: "appointment_1",
      });
      if (started.status !== "started") {
        throw new Error("The Entity-bound run was refused");
      }

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const cancel = yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityType: "appointment",
            entityId: "appointment_1",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
          });
          const exit = yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_condition_not_met",
            nodeId: "node_check",
          });
          const refusedExitFinish = yield* executions.finishRun({
            executionId: started.execution.id,
            status: "exited",
          });
          const canceled = yield* executions.finishRun({
            executionId: started.execution.id,
            status: "canceled",
          });
          const repeatedCancel = yield* executions.endInFlight({
            executionId: started.execution.id,
            status: "canceled",
          });
          return { cancel, exit, refusedExitFinish, canceled, repeatedCancel };
        })
      );

      const expectedClaim = {
        kind: "cancel",
        eventName: "appointment/cancelled",
        payload: { reason: "host request" },
      } as const;
      expect(result.cancel).toEqual([started.execution.id]);
      expect(result.exit).toMatchObject({
        status: "running",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.refusedExitFinish).toMatchObject({
        status: "running",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.canceled).toMatchObject({
        status: "canceled",
        claim: expectedClaim,
        didWrite: true,
      });
      expect(result.repeatedCancel).toMatchObject({
        status: "canceled",
        claim: expectedClaim,
        didWrite: false,
      });
    });

    // A refused send closes a row only when no run could still need it: a
    // claimed row is finished by the run holding the claim, and a stamped row
    // was taken by the bus through another attempt's send.
    it("closes a refused enqueue only for an unclaimed row the bus never took", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const startFor = async (entityId: string) => {
        const started = await attemptStart(database, {
          deliveryId: `delivery_${entityId}`,
          entityType: "appointment",
          entityId,
        });
        if (started.status !== "started") {
          throw new Error("The unlimited start was refused");
        }
        return started.execution.id;
      };
      const cancelClaimed = await startFor("appt_cancel");
      const exitClaimed = await startFor("appt_exit");
      const enqueued = await startFor("appt_enqueued");
      const unsent = await startFor("appt_unsent");

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityType: "appointment",
            entityId: "appt_cancel",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: {},
          });
          yield* executions.requestExit({
            executionId: exitClaimed,
            reason: "entity_condition_not_met",
            nodeId: "node_check",
          });
          yield* executions.markEnqueued({
            executionId: enqueued,
            runId: "run_enqueued",
          });

          const close = (executionId: string) =>
            executions.markEnqueueFailed({ executionId, error: "refused" });
          const closed = {
            cancelClaimed: yield* close(cancelClaimed),
            exitClaimed: yield* close(exitClaimed),
            enqueued: yield* close(enqueued),
            unsent: yield* close(unsent),
            unsentAgain: yield* close(unsent),
          };

          const statusOf = (executionId: string) =>
            Effect.map(
              executions.findSummaryById(executionId),
              (summary) => summary?.status
            );
          const statuses = {
            cancelClaimed: yield* statusOf(cancelClaimed),
            exitClaimed: yield* statusOf(exitClaimed),
            enqueued: yield* statusOf(enqueued),
            unsent: yield* statusOf(unsent),
          };
          return { closed, statuses };
        })
      );

      expect(result.closed).toEqual({
        cancelClaimed: false,
        exitClaimed: false,
        enqueued: false,
        unsent: true,
        unsentAgain: false,
      });
      expect(result.statuses).toEqual({
        cancelClaimed: "running",
        exitClaimed: "running",
        enqueued: "running",
        unsent: "failed",
      });
    });

    it("enforces workflow-name and workflow-run uniqueness", async () => {
      const database = await openConnection();
      await database.run(
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
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.updateMetadata({
              workflowId: "wf_2",
              updates: {
                name: "appointments",
                updatedAt: new Date(),
              },
            });
          })
        )
      ).rejects.toBeDefined();

      const executionIds = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const first = yield* executions.startForEntity({
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
          const second = yield* executions.startForEntity({
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
          if (first.status !== "started" || second.status !== "started") {
            throw new Error("Unlimited start was refused");
          }
          yield* executions.markEnqueued({
            executionId: first.execution.id,
            runId: "run_1",
          });
          return [first.execution.id, second.execution.id];
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            yield* executions.markEnqueued({
              executionId: executionIds[1],
              runId: "run_1",
            });
          })
        )
      ).rejects.toBeDefined();
    });

    it("implements the execution, log, wait, and audit repository contracts", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          const start = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              startEventName: "appointment/created",
              entityValue: "appointment_1",
              deliveryId: "delivery_1",
              runMode: "live",
              input: { appointmentId: "appointment_1" },
            },
            concurrency: "first-wins",
            supersededReason: "newer start",
          });
          if (start.status !== "started") throw new Error("Start was refused");
          const executionId = start.execution.id;
          yield* executions.markEnqueued({ executionId, runId: "run_1" });

          const successfulLog = yield* executions.openNodeLog({
            executionId,
            nodeId: "node_1",
            nodeName: "Create task",
            nodeType: "action",
            input: { title: "Call patient" },
          });
          yield* executions.closeNodeLog({
            logId: successfulLog,
            status: "success",
            output: { taskId: "task_1" },
            durationMs: 12,
          });
          yield* executions.openNodeLog({
            executionId,
            nodeId: "node_2",
            nodeName: "Notify",
            nodeType: "action",
          });

          const wait = yield* executions.startWait({
            side: "started",
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
            metadata: { expression: "true" },
          });
          if (!wait) throw new Error("Wait was refused");
          const waitsForEvent = yield* executions.listWaitsForEvent({
            workflowId: "wf_1",
            eventName: "appointment/approved",
            limit: 10,
          });
          const subscribers = yield* workflows.listEventSubscribers(
            "appointment/approved"
          );
          const firstClaim = yield* executions.claimWaitingStateByToken({
            resumeToken: "resume_1",
            arrival: EVENT_ARRIVAL,
          });
          if (!firstClaim) throw new Error("Wait claim was refused");
          const released = yield* executions.releaseWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: firstClaim.claimedAt,
          });
          const secondClaim = yield* executions.claimWaitingStateById({
            waitStateId: wait.waitStateId,
            eventName: EVENT_ARRIVAL.eventName,
            arrival: EVENT_ARRIVAL,
          });
          if (!secondClaim) throw new Error("Released wait was not claimable");
          const settled = yield* executions.settleWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: secondClaim.claimedAt,
          });
          yield* executions.markRunning({
            side: "started",
            executionId,
            workflowVersionId: "ver_1",
          });

          const cancelled = yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityValue: "appointment_1",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
          });
          const pendingCancel =
            yield* executions.findPendingCancel(executionId);
          yield* executions.cancelOpenNodeLogs(executionId);
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId,
            eventType: "run_completed",
            message: "Completed",
          });
          const finished = yield* executions.finishRun({
            executionId,
            status: "canceled",
          });

          const snapshot = {
            executionId,
            waitsForEvent,
            subscribers,
            released,
            settled,
            cancelled,
            pendingCancel,
            finished,
            summary: yield* executions.findSummaryById(executionId),
            status: yield* executions.findStatusById(executionId),
            page: yield* executions.listPage({ limit: 10 }),
            logs: yield* executions.listLogs(executionId),
            outputs: yield* executions.readNodeOutputs(executionId),
            events: yield* executions.listEvents(executionId),
          };
          const deleted = yield* executions.deleteAllForWorkflow("wf_1");
          return {
            ...snapshot,
            deleted,
            existsAfterDelete: yield* executions.existsById(executionId),
          };
        })
      );

      expect(result.waitsForEvent).toHaveLength(1);
      expect(result.subscribers).toMatchObject([
        { id: "wf_1", roles: ["wait"] },
      ]);
      expect(result.released).toBe(true);
      expect(result.settled).toBe(true);
      expect(result.cancelled).toEqual([result.executionId]);
      expect(result.pendingCancel).toEqual({
        eventName: "appointment/cancelled",
        payload: { reason: "host request" },
      });
      expect(result.finished).toMatchObject({
        executionId: result.executionId,
        status: "canceled",
        claim: { kind: "cancel", eventName: "appointment/cancelled" },
        didWrite: true,
      });
      expect(result.summary).toMatchObject({
        status: "canceled",
        output: null,
      });
      expect(result.status).toEqual({
        id: result.executionId,
        status: "canceled",
      });
      expect(result.page).toMatchObject([
        { workflowName: "Appointments", workflowIsPaused: false },
      ]);
      expect(result.logs.map((log) => log.status).toSorted()).toEqual([
        "cancelled",
        "success",
      ]);
      expect(result.outputs).toEqual({ node_1: { taskId: "task_1" } });
      expect(result.events).toMatchObject([{ message: "Completed" }]);
      expect(result.deleted).toBe(1);
      expect(result.existsAfterDelete).toBe(false);
    });

    it("lets the first Cancel Event claim a run and the second claim nothing", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
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

          const cancel = (reason: string) =>
            executions.requestCancelForEntity({
              workflowId: "wf_1",
              entityValue: "appointment_1",
              runMode: "live",
              eventName: "appointment/cancelled",
              payload: { reason },
            });

          return {
            first: yield* cancel("first"),
            second: yield* cancel("second"),
            pending: yield* executions.findPendingCancel(started.execution.id),
          };
        })
      );

      expect(result.first).toHaveLength(1);
      // The second Cancel Event finds the run already claimed, so it claims
      // nothing and the payload the first one carried is the one that stands.
      expect(result.second).toEqual([]);
      expect(result.pending).toMatchObject({
        eventName: "appointment/cancelled",
        payload: { reason: "first" },
      });
    });

    it("keeps workflow audit rows apart from a run's timeline", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
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

          // These workflow-scoped rows and the run-scoped row exercise both
          // audit readers. A workflow audit read without its scope filter would
          // return the run's row too.
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "A run for this entity was already going",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "cancel_not_delivered",
            message: "The cancel event reached no run",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId: started.execution.id,
            eventType: "run_completed",
            message: "Completed",
          });

          return {
            workflowEvents: [
              ...(yield* executions.listWorkflowEvents({
                workflowId: "wf_1",
                eventType: "run_refused",
              })),
              ...(yield* executions.listWorkflowEvents({
                workflowId: "wf_1",
                eventType: "cancel_not_delivered",
              })),
            ],
            runEvents: yield* executions.listEvents(started.execution.id),
          };
        })
      );

      expect(
        result.workflowEvents.map((event) => event.eventType).toSorted()
      ).toEqual(["cancel_not_delivered", "run_refused"]);
      expect(result.runEvents.map((event) => event.eventType)).toEqual([
        "run_completed",
      ]);
    });

    it("returns a run's timeline newest first, in insertion order", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              runMode: "live",
              entityValue: "appointment_1",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }

          // The repository offers no way for a caller to put several audit rows
          // in one transaction, so these three are written back to back. They
          // still land in the same millisecond often enough to decide the
          // assertion: SQLite stores whole milliseconds, and PostgreSQL takes
          // created_at from now(), which any transaction writing more than one
          // row repeats. Each backend carries a sort key that grows with every
          // insert, the rowid on SQLite and the seq identity column on
          // PostgreSQL, and that key is what puts these three in order.
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId: started.execution.id,
            eventType: "run_started",
            message: "Started",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId: started.execution.id,
            eventType: "run_waiting",
            message: "Waiting",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId: started.execution.id,
            eventType: "run_resumed",
            message: "Resumed",
          });

          return yield* executions.listEvents(started.execution.id);
        })
      );

      expect(result.map((event) => event.message)).toEqual([
        "Resumed",
        "Waiting",
        "Started",
      ]);
    });

    it("limits each workflow audit event type independently", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      await seedPublishedWorkflow(database, {
        workflowId: "wf_2",
        versionId: "ver_2",
        name: "Follow-ups",
      });

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;

          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "cancel_not_delivered",
            message: "The older cancel event reached no run",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "Oldest refused start",
          });
          yield* Effect.sleep(5);
          yield* Effect.forEach(Array.from({ length: 50 }), (_, index) =>
            executions.recordAuditEvent({
              workflowId: "wf_1",
              eventType: "run_refused",
              message: `Refused start ${index}`,
            })
          );

          yield* executions.recordAuditEvent({
            workflowId: "wf_2",
            eventType: "run_refused",
            message: "The older start was refused",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_2",
            eventType: "cancel_not_delivered",
            message: "Oldest cancel event",
          });
          yield* Effect.sleep(5);
          yield* Effect.forEach(Array.from({ length: 50 }), (_, index) =>
            executions.recordAuditEvent({
              workflowId: "wf_2",
              eventType: "cancel_not_delivered",
              message: `Cancel event ${index} reached no run`,
            })
          );

          return {
            workflowOneRefusals: yield* executions.listWorkflowEvents({
              workflowId: "wf_1",
              eventType: "run_refused",
            }),
            workflowOneCancellations: yield* executions.listWorkflowEvents({
              workflowId: "wf_1",
              eventType: "cancel_not_delivered",
            }),
            workflowTwoRefusals: yield* executions.listWorkflowEvents({
              workflowId: "wf_2",
              eventType: "run_refused",
            }),
            workflowTwoCancellations: yield* executions.listWorkflowEvents({
              workflowId: "wf_2",
              eventType: "cancel_not_delivered",
            }),
          };
        })
      );

      expect(result.workflowOneRefusals).toHaveLength(50);
      expect(result.workflowOneCancellations).toMatchObject([
        { eventType: "cancel_not_delivered" },
      ]);
      expect(result.workflowTwoRefusals).toMatchObject([
        { eventType: "run_refused" },
      ]);
      expect(result.workflowTwoCancellations).toHaveLength(50);
      expect(
        result.workflowOneRefusals.map((event) => event.message)
      ).not.toContain("Oldest refused start");
      expect(
        result.workflowTwoCancellations.map((event) => event.message)
      ).not.toContain("Oldest cancel event");
    });
  });
}
