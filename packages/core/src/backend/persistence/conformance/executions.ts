/**
 * Runs: how they open, park, resume, cancel and are read back.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
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

/** The first-wins start the race cases in this file make. */
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
          const apiKeys = yield* ApiKeyRepo;
          const executions = yield* ExecutionRepo;
          yield* apiKeys.insert({
            name: "Deploy",
            keyHash: "hash",
            keyPrefix: "wfg_test",
          });
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
          const apiKeys = yield* ApiKeyRepo;
          const executions = yield* ExecutionRepo;
          return {
            keys: yield* apiKeys.listNewestFirst,
            workflow: yield* workflows.findById("wf_1"),
            events: yield* executions.listWorkflowEvents("wf_1"),
          };
        })
      );

      expect(state.keys).toMatchObject([
        { name: "Deploy", keyPrefix: "wfg_test" },
      ]);
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

    it("fences concurrent wait claims", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      await seedPublishedWorkflow(database);

      const waitStateId = await database.run(
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
            waitType: "event",
            resumeToken: "resume_1",
          });
          if (!wait) throw new Error("wait refused");
          return wait.waitStateId;
        })
      );

      const claim = (connection: ConformanceConnection) =>
        connection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.claimWaitingStateById(waitStateId);
          })
        );
      const claims = await Promise.all([
        claim(database),
        claim(otherConnection),
      ]);
      expect(claims.filter((value) => value !== null)).toHaveLength(1);
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
            return yield* workflows.update({
              workflowId: "wf_2",
              updates: {
                name: "appointments",
                updatedAt: new Date(),
              },
              eventSubscriptions: "unchanged",
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
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
            metadata: { expression: "true" },
          });
          if (!wait) throw new Error("Wait was refused");
          const waitsForEvent = yield* executions.listWaitsForEvent({
            workflowId: "wf_1",
            eventName: "appointment/approved",
            runMode: "live",
            limit: 10,
          });
          const subscribers = yield* workflows.listEventSubscribers(
            "appointment/approved"
          );
          const firstClaim =
            yield* executions.claimWaitingStateByToken("resume_1");
          if (!firstClaim) throw new Error("Wait claim was refused");
          const released = yield* executions.releaseWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: firstClaim.claimedAt,
          });
          const secondClaim = yield* executions.claimWaitingStateById(
            wait.waitStateId
          );
          if (!secondClaim) throw new Error("Released wait was not claimable");
          const settled = yield* executions.settleWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: secondClaim.claimedAt,
          });
          yield* executions.markRunning(executionId);

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
            status: "completed",
            output: { ok: true },
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
      expect(result.finished).toBe(true);
      expect(result.summary).toMatchObject({
        status: "completed",
        output: { ok: true },
      });
      expect(result.status).toEqual({
        id: result.executionId,
        status: "completed",
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

    it("pages waits for an Event by id, and filters the runs a delivery settled", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionIds: string[] = [];
          for (const suffix of ["a", "b", "c"]) {
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
            executionIds.push(started.execution.id);
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

          const firstExecutionId = executionIds[0];
          if (!firstExecutionId) {
            throw new Error("No run was started");
          }

          const query = {
            workflowId: "wf_1",
            eventName: "appointment/approved",
            runMode: "live" as const,
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
      expect(result.firstPage.map((wait) => wait.id)).toEqual(ids.slice(0, 2));
      expect(result.secondPage.map((wait) => wait.id)).toEqual(ids.slice(2));
      expect(result.excludingOne.map((wait) => wait.executionId)).not.toContain(
        result.executionIds[0]
      );
      expect(result.excludingOne).toHaveLength(2);
      expect(result.excludingNone).toHaveLength(3);
      expect(result.otherEvent).toEqual([]);
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

    it("keeps the workflow's own audit rows apart from a run's timeline", async () => {
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

          // One row of each scope. A workflow read that did not filter by type
          // would return the run's row too, which is the regression this pins.
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            eventType: "run_refused",
            message: "A run for this entity was already going",
          });
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId: started.execution.id,
            eventType: "run_completed",
            message: "Completed",
          });

          return {
            workflowEvents: yield* executions.listWorkflowEvents("wf_1"),
            runEvents: yield* executions.listEvents(started.execution.id),
          };
        })
      );

      expect(result.workflowEvents.map((event) => event.eventType)).toEqual([
        "run_refused",
      ]);
      expect(result.runEvents.map((event) => event.eventType)).toEqual([
        "run_completed",
      ]);
    });
  });
}
