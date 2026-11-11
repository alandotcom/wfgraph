/**
 * The executions aggregate's share of run-history retention: which ended runs
 * and workflow audit rows a sweep deletes, what goes with a run by cascade,
 * and the rows a redelivery of a surviving inbox row still answers from.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  CaseDatabase,
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  attemptStart,
  seedPublishedWorkflow,
  setTimestamp,
  terminalEntry,
  verdict,
} from "#src/backend/persistence/conformance/support";
import {
  RETENTION_CUTOFF,
  T0,
  at,
  leaseDelivery,
} from "#src/backend/persistence/conformance/schedule-support";

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

export function describeExecutionRetentionConformance({
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("run-history retention", () => {
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
                announcement: terminalEntry,
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

      // An in-flight run carries no `completed_at`, which
      // `workflow_executions_completed_check` holds it to, and the database
      // refuses one written anyway. An old start leaves its status as the
      // thing keeping it.
      await expect(
        setTimestamp(database, {
          table: "workflow_executions",
          column: "completed_at",
          where: `id = '${executionId}'`,
          at: new Date("2020-01-01T00:00:00.000Z"),
        })
      ).rejects.toThrow();
      await setTimestamp(database, {
        table: "workflow_executions",
        column: "started_at",
        where: `id = '${executionId}'`,
        at: new Date("2020-01-01T00:00:00.000Z"),
      });

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
          yield* executions.endRun({
            executionId,
            ending: verdict("completed"),
          });
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

      expect(before).toEqual({ logs: 1, events: 2, wait: true });
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
            yield* executions.endRun({
              executionId,
              ending: verdict("completed"),
            });
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
