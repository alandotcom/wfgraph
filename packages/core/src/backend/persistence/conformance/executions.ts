/**
 * These cases cover runs: how they open, park, resume, cancel, and are read
 * back.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  CaseDatabase,
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  attemptStart,
  cancelArrival,
  emptyGraph,
  notYetDue,
  seedPublishedWorkflow,
  setTimestamp,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  at,
  leaseDelivery,
} from "#src/backend/persistence/conformance/schedule-support";

/**
 * The wake a claim records on the row it takes, which every claim case here
 * passes because a claim writes one.
 */
const EVENT_ARRIVAL = {
  eventName: "appointment/approved",
  payload: { approved: true },
} as const;

/** When a claim or a Cancel claim writes, which a re-queue is due at. */
const NOW = new Date("2026-01-01T00:00:00.000Z");

/** The `olderThan` cutoff the sweep cases pass: an hour after `T0`. */
const RETENTION_CUTOFF = at(3_600_000);

/** Sets the `completed_at` of the Execution `executionId` names to `when`. */
function setCompletedAt(
  database: CaseDatabase,
  executionId: string,
  when: Date
): Promise<void> {
  return setTimestamp(database, {
    table: "workflow_executions",
    column: "completed_at",
    where: `id = '${executionId}'`,
    at: when,
  });
}

/** Opens a run against the seeded workflow and answers its id. */
async function startedRunId(
  connection: ConformanceConnection,
  deliveryId: string
): Promise<string> {
  const started = await attemptStart(connection, { deliveryId });
  if (started.status !== "started") throw new Error("Start was refused");
  return started.execution.id;
}

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
            now: NOW,
            workflowId: "wf_1",
            entityType: "appointment",
            entityId: "appt_8813",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: {},
            deliveryId: yield* cancelArrival(),
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
            now: NOW,
            workflowId: "wf_1",
            entityType: "appointment",
            entityId: "appointment_1",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
            deliveryId: yield* cancelArrival(),
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
      // The claim makes the run due at once, though its start was not yet due.
      expect(result.cancel).toEqual([
        {
          kind: "claimed",
          executionId: started.execution.id,
          resolvedParks: 0,
          requeued: true,
        },
      ]);
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

    // The Intake model's `ExecutionAndScheduleTogether`: an open run always has
    // a schedule row, because one write inserts both, and a start Concurrency
    // refuses or displaces leaves no schedule row behind.
    it("opens a run with its schedule row and its opening entry, and leaves no schedule row on a run it refuses or displaces", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);
      const dueAt = new Date("2026-03-01T09:00:00.000Z");

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const start = (input: {
            deliveryId: string;
            concurrency: "first-wins" | "newest-wins";
          }) =>
            executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: "appointment_1",
                deliveryId: input.deliveryId,
                input: {},
              },
              concurrency: input.concurrency,
              supersededReason: "newer start",
              startedEntry: {
                message: "Event-triggered run of v1 started",
                metadata: { startSource: "event" },
              },
              now: dueAt,
            });

          const first = yield* start({
            deliveryId: "delivery_1",
            concurrency: "first-wins",
          });
          const refused = yield* start({
            deliveryId: "delivery_2",
            concurrency: "first-wins",
          });
          const newer = yield* start({
            deliveryId: "delivery_3",
            concurrency: "newest-wins",
          });
          if (first.status !== "started" || newer.status !== "started") {
            throw new Error("Start was refused");
          }
          const firstId = first.execution.id;
          const newerId = newer.execution.id;
          return {
            refused,
            superseded: newer.supersededExecutionIds,
            firstSchedule: yield* executions.findSchedule({
              executionId: firstId,
            }),
            newerSchedule: yield* executions.findSchedule({
              executionId: newerId,
            }),
            newerEntries: yield* executions.listEvents(newerId),
          };
        })
      );

      expect(result.refused.status).toBe("refused");
      expect(result.superseded).toHaveLength(1);
      expect(result.firstSchedule).toBeNull();
      expect(result.newerSchedule).toMatchObject({
        kind: "run",
        state: "queued",
        wakeAt: dueAt,
        attempt: 0,
      });
      expect(result.newerEntries).toMatchObject([
        {
          eventType: "run_started",
          message: "Event-triggered run of v1 started",
          metadata: { startSource: "event" },
        },
      ]);
    });

    it("enforces workflow-name uniqueness", async () => {
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
    });

    it("lets a later close of a node log replace an earlier attempt's error", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const logs = await database.run(
        Effect.gen(function* () {
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
            ...notYetDue,
          });
          if (start.status !== "started") throw new Error("Start was refused");
          const executionId = start.execution.id;

          const logId = yield* executions.openNodeLog({
            executionId,
            nodeId: "node_1",
            nodeName: "Create task",
            nodeType: "action",
          });
          yield* executions.closeNodeLog({
            logId,
            status: "error",
            error: "vendor timed out",
            durationMs: 5,
          });
          yield* executions.closeNodeLog({
            logId,
            status: "success",
            output: { taskId: "task_1" },
            durationMs: 9,
          });
          return yield* executions.listLogs(executionId);
        })
      );

      expect(logs).toMatchObject([
        { status: "success", output: { taskId: "task_1" }, error: null },
      ]);
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
            ...notYetDue,
          });
          if (start.status !== "started") throw new Error("Start was refused");
          const executionId = start.execution.id;

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
            now: NOW,
            resumeToken: "resume_1",
            arrival: EVENT_ARRIVAL,
          });
          if (!firstClaim) throw new Error("Wait claim was refused");
          const secondClaim = yield* executions.claimWaitingStateById({
            now: NOW,
            waitStateId: wait.waitStateId,
            resumeToken: "resume_1",
            eventName: EVENT_ARRIVAL.eventName,
            arrival: EVENT_ARRIVAL,
          });
          const settled = yield* executions.markWaitStatus({
            waitStateId: wait.waitStateId,
            status: "resumed",
          });
          yield* executions.markRunning({
            side: "started",
            executionId,
            workflowVersionId: "ver_1",
          });

          const cancelled = yield* executions.requestCancelForEntity({
            now: NOW,
            workflowId: "wf_1",
            entityValue: "appointment_1",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
            deliveryId: yield* cancelArrival(),
          });
          const pendingCancel =
            yield* executions.findPendingCancel(executionId);
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
            secondClaim,
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
      // A claimed row holds its wake until the run closes it.
      expect(result.secondClaim).toBeNull();
      expect(result.settled).toBe(true);
      // The resume claim before it already made the run due.
      expect(result.cancelled).toEqual([
        {
          kind: "claimed",
          executionId: result.executionId,
          resolvedParks: 0,
          requeued: false,
        },
      ]);
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
        "running",
        "success",
      ]);
      expect(result.outputs).toEqual({ node_1: { taskId: "task_1" } });
      expect(result.events).toMatchObject([
        { message: "Completed" },
        {
          eventType: "run_cancel_requested",
          message: "Cancellation requested by appointment/cancelled",
          metadata: { eventName: "appointment/cancelled", parkedWaits: 0 },
        },
        { eventType: "run_started", message: notYetDue.startedEntry.message },
      ]);
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
            ...notYetDue,
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }

          // Each call is a Cancel Event of its own, with an inbox row of its own.
          const cancel = (reason: string) =>
            Effect.flatMap(cancelArrival(), (deliveryId) =>
              executions.requestCancelForEntity({
                now: NOW,
                workflowId: "wf_1",
                entityValue: "appointment_1",
                runMode: "live",
                eventName: "appointment/cancelled",
                payload: { reason },
                deliveryId,
              })
            );

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
            ...notYetDue,
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
        "run_started",
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
            ...notYetDue,
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

      // The oldest is the opening entry the start wrote beside its row.
      expect(result.map((event) => event.message)).toEqual([
        "Resumed",
        "Waiting",
        "Started",
        notYetDue.startedEntry.message,
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

    it("sweeps ended runs that completed before the window, oldest first and a batch at a time", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      const ended = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const endRun = (status: "completed" | "failed" | "canceled") =>
            executions
              .insertTerminal({
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "manual",
                runMode: "live",
                input: {},
                status,
              })
              .pipe(Effect.map((execution) => execution.id));
          return {
            oldest: yield* endRun("completed"),
            older: yield* endRun("failed"),
            old: yield* endRun("canceled"),
            young: yield* endRun("completed"),
          };
        })
      );
      await setCompletedAt(database, ended.oldest, T0);
      await setCompletedAt(database, ended.older, at(1_000));
      await setCompletedAt(database, ended.old, at(2_000));
      await setCompletedAt(database, ended.young, at(7_200_000));

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const window = { olderThan: RETENTION_CUTOFF };
          const firstSweep = yield* executions.sweepEndedExecutions({
            ...window,
            limit: 2,
          });
          const afterFirstSweep = {
            oldest: yield* executions.existsById(ended.oldest),
            older: yield* executions.existsById(ended.older),
            old: yield* executions.existsById(ended.old),
          };
          return {
            sweeps: [
              firstSweep,
              yield* executions.sweepEndedExecutions({ ...window, limit: 10 }),
              yield* executions.sweepEndedExecutions({ ...window, limit: 10 }),
            ],
            afterFirstSweep,
            oldAfter: yield* executions.existsById(ended.old),
            youngAfter: yield* executions.existsById(ended.young),
          };
        })
      );

      expect(result.sweeps).toEqual([2, 1, 0]);
      expect(result.afterFirstSweep).toEqual({
        oldest: false,
        older: false,
        old: true,
      });
      expect(result.oldAfter).toBe(false);
      expect(result.youngAfter).toBe(true);
    });

    it("never sweeps an in-flight run, however old", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const executionId = await startedRunId(connection, "delivery_old");

      // An in-flight run carries no `completed_at`. Giving this one an old
      // value anyway leaves its status as the only thing keeping it.
      await Promise.all(
        ["started_at", "completed_at"].map((column) =>
          setTimestamp(database, {
            table: "workflow_executions",
            column,
            where: `id = '${executionId}'`,
            at: new Date("2020-01-01T00:00:00.000Z"),
          })
        )
      );

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return {
            swept: yield* executions.sweepEndedExecutions({
              olderThan: RETENTION_CUTOFF,
              limit: 10,
            }),
            status: yield* executions.findStatusById(executionId),
          };
        })
      );

      expect(result.swept).toBe(0);
      expect(IN_FLIGHT_EXECUTION_STATUSES).toContain(result.status?.status);
    });

    it("takes a swept run's node logs, wait rows and timeline with it", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const executionId = await startedRunId(connection, "delivery_1");

      const waitStateId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.openNodeLog({
            executionId,
            nodeId: "node_1",
            nodeName: "Create task",
            nodeType: "action",
          });
          const wait = yield* executions.startWait({
            side: "started",
            executionId,
            workflowId: "wf_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
            metadata: {},
          });
          if (!wait) throw new Error("Wait was refused");
          yield* executions.finishRun({ executionId, status: "completed" });
          return wait.waitStateId;
        })
      );
      await setCompletedAt(database, executionId, T0);

      const read = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          logs: (yield* executions.listLogs(executionId)).length,
          events: (yield* executions.listEvents(executionId)).length,
          wait: (yield* executions.findWaitStateById(waitStateId)) !== null,
        };
      });
      const before = await connection.run(read);
      const swept = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.sweepEndedExecutions({
            olderThan: RETENTION_CUTOFF,
            limit: 10,
          });
        })
      );
      const after = await connection.run(read);

      expect(before).toEqual({ logs: 1, events: 1, wait: true });
      expect(swept).toBe(1);
      expect(after).toEqual({ logs: 0, events: 0, wait: false });
    });

    it("sweeps workflow audit rows written before the window, a batch at a time, and leaves a run's timeline", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const executionId = await startedRunId(connection, "delivery_1");

      await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "Old refused start",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "cancel_not_delivered",
            message: "Old cancel event reached no run",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "Young refused start",
          });
        })
      );
      const createdAt: readonly (readonly [string, Date])[] = [
        ["message = 'Old refused start'", T0],
        ["message = 'Old cancel event reached no run'", at(1_000)],
        ["message = 'Young refused start'", at(7_200_000)],
        // The run's opening entry names its run, so only the run's own sweep
        // removes it, however old it is.
        [`execution_id = '${executionId}'`, T0],
      ];
      await Promise.all(
        createdAt.map(([where, when]) =>
          setTimestamp(database, {
            table: "workflow_execution_events",
            column: "created_at",
            where,
            at: when,
          })
        )
      );

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const window = { olderThan: RETENTION_CUTOFF };
          return {
            sweeps: [
              yield* executions.sweepWorkflowAuditEvents({
                ...window,
                limit: 1,
              }),
              yield* executions.sweepWorkflowAuditEvents({
                ...window,
                limit: 10,
              }),
              yield* executions.sweepWorkflowAuditEvents({
                ...window,
                limit: 10,
              }),
            ],
            refusals: yield* executions.listWorkflowEvents({
              workflowId: "wf_1",
              eventType: "run_refused",
            }),
            cancellations: yield* executions.listWorkflowEvents({
              workflowId: "wf_1",
              eventType: "cancel_not_delivered",
            }),
            timeline: yield* executions.listEvents(executionId),
          };
        })
      );

      expect(result.sweeps).toEqual([1, 1, 0]);
      expect(result.refusals.map((event) => event.message)).toEqual([
        "Young refused start",
      ]);
      expect(result.cancellations).toEqual([]);
      expect(result.timeline).toMatchObject([{ eventType: "run_started" }]);
    });

    it("keeps an ended run while the inbox row that opened it is pending or reopened, and sweeps it once the row is gone", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      // One arrival still pending, and one whose delivery failed and a resend
      // of its key reopened. Each keeps its first `received_at`, so neither
      // ages out of the inbox while it waits.
      const inbox = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const arrive = (idempotencyKey: string) =>
            executions.insertInboxEvent({
              name: "appointment/booked",
              data: {},
              connectionId: null,
              idempotencyKey,
              now: T0,
            });
          const pending = yield* arrive("vendor_pending");
          const reopened = yield* arrive("vendor_reopened");
          if (reopened.duplicate)
            throw new Error("The arrival was a duplicate");
          return { pending: pending.inboxId, reopened };
        })
      );
      const fence = await leaseDelivery(database, inbox.reopened, "owner_1");
      await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.failDelivery({
            fence,
            error: "The subscriber step failed",
            now: at(1_000),
          });
          yield* executions.insertInboxEvent({
            name: "appointment/booked",
            data: {},
            connectionId: null,
            idempotencyKey: "vendor_reopened",
            now: at(2_000),
          });
        })
      );

      const runs = {
        pending: await startedRunId(connection, inbox.pending),
        reopened: await startedRunId(connection, inbox.reopened.inboxId),
        settled: await startedRunId(connection, "delivery_swept"),
      };
      await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          for (const executionId of Object.values(runs)) {
            yield* executions.finishRun({ executionId, status: "completed" });
          }
        })
      );
      await Promise.all(
        Object.values(runs).map((executionId) =>
          setCompletedAt(database, executionId, T0)
        )
      );

      const sweep = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.sweepEndedExecutions({
          olderThan: RETENTION_CUTOFF,
          limit: 10,
        });
      });
      const exists = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          pending: yield* executions.existsById(runs.pending),
          reopened: yield* executions.existsById(runs.reopened),
          settled: yield* executions.existsById(runs.settled),
        };
      });
      const firstSweep = await connection.run(sweep);
      const afterFirstSweep = await connection.run(exists);
      await database.execute(
        `delete from workflow_event_inbox where id = '${inbox.pending}'`
      );
      const secondSweep = await connection.run(sweep);
      const afterSecondSweep = await connection.run(exists);

      expect(firstSweep).toBe(1);
      expect(afterFirstSweep).toEqual({
        pending: true,
        reopened: true,
        settled: false,
      });
      expect(secondSweep).toBe(1);
      expect(afterSecondSweep).toEqual({
        pending: false,
        reopened: true,
        settled: false,
      });
    });

    it("keeps an Entity admission refusal while the inbox row it answers exists, and sweeps it once the row is gone", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);

      const deliveryId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const arrival = yield* executions.insertInboxEvent({
            name: "appointment/booked",
            data: {},
            connectionId: null,
            idempotencyKey: null,
            now: T0,
          });
          const refuse = (input: { deliveryId: string; decisionId: string }) =>
            executions.recordAdmissionRefusal({
              workflowId: "wf_1",
              ...input,
              reason: "entity_condition_not_met",
              message: "Entity Eligibility refused the start",
              metadata: { reason: "entity_condition_not_met" },
            });
          yield* refuse({
            deliveryId: arrival.inboxId,
            decisionId: "admission_kept",
          });
          yield* refuse({
            deliveryId: "delivery_swept",
            decisionId: "admission_swept",
          });
          return arrival.inboxId;
        })
      );
      await setTimestamp(database, {
        table: "workflow_execution_events",
        column: "created_at",
        where: `event_type = 'run_refused'`,
        at: T0,
      });

      const sweep = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.sweepWorkflowAuditEvents({
          olderThan: RETENTION_CUTOFF,
          limit: 10,
        });
      });
      const refusals = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const find = (decisionId: string) =>
          executions.findAdmissionRefusal({ workflowId: "wf_1", decisionId });
        return {
          kept: yield* find("admission_kept"),
          swept: yield* find("admission_swept"),
        };
      });
      const firstSweep = await connection.run(sweep);
      const afterFirstSweep = await connection.run(refusals);
      await database.execute(
        `delete from workflow_event_inbox where id = '${deliveryId}'`
      );
      const secondSweep = await connection.run(sweep);
      const afterSecondSweep = await connection.run(refusals);

      expect(firstSweep).toBe(1);
      expect(afterFirstSweep).toEqual({
        kept: "entity_condition_not_met",
        swept: null,
      });
      expect(secondSweep).toBe(1);
      expect(afterSecondSweep).toEqual({ kept: null, swept: null });
    });
  });
}
