/**
 * These cases cover runs: how they open, park, resume, cancel, and are read
 * back.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { sortBy } from "es-toolkit/array";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { recordVerdict } from "#src/backend/engine/terminal-record";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { makeExecutionDriverLayer } from "#src/backend/services/executions/driver";
import { cancelInFlightRuns } from "#src/backend/services/executions/end-runs";
import { recordPausedRunIgnored } from "#src/backend/services/executions/run-rows";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
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
  verdict,
} from "#src/backend/persistence/conformance/support";

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

/** A timeline entry a case has the database refuse. */
type RefusedEntry =
  | "run_completed"
  | "run_cancelled"
  | "run_superseded"
  | "run_ignored";

/**
 * A trigger refusing every timeline entry of `eventType`, which is how an
 * insert the database fails, or a process dying before the insert, leaves the
 * entry unwritten.
 */
function refuseEntry(eventType: RefusedEntry) {
  const name = `refuse_${eventType}`;
  return {
    postgresql: `create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'timeline entry refused'; end $$;
    create trigger ${name} before insert on workflow_execution_events
    for each row when (new.event_type = '${eventType}') execute function ${name}();`,
    sqlite: `create trigger ${name} before insert on workflow_execution_events
    when new.event_type = '${eventType}' begin select raise(abort, 'timeline entry refused'); end;`,
  };
}

function acceptEntry(eventType: RefusedEntry) {
  const name = `refuse_${eventType}`;
  return {
    postgresql: `drop trigger ${name} on workflow_execution_events; drop function ${name}();`,
    sqlite: `drop trigger ${name};`,
  };
}

/**
 * One attempt of the durable step that starts a newest-wins run of `wf_1` for
 * an arrival. A refused attempt fails the step, which the executor runs again.
 */
const startNewestWins = (deliveryId: string) =>
  Effect.gen(function* () {
    const appLogger = yield* AppLogger;
    return yield* startWithConcurrency({
      workflow: {
        id: "wf_1",
        name: "Appointments",
        graph: emptyGraph,
        versionId: "ver_1",
        catalogFingerprint: "catalog",
      },
      concurrency: "newest-wins",
      start: {
        source: "event",
        eventName: "appointment/rescheduled",
        deliveryId,
        entityValue: "appointment_1",
      },
      runMode: "live",
      payload: {},
      logger: appLogger.get("conformance"),
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SilentAppLoggerLayer, makeExecutionDriverLayer([]))
    )
  );

/** 1,200 ended runs of one workflow, inserted in one statement. */
const bulkRuns = (workflowId: string, versionId: string) => ({
  postgresql: `insert into workflow_executions (id, workflow_id, workflow_version_id, status, start_source, started_at, completed_at, duration) select '${workflowId}_run_' || i, '${workflowId}', '${versionId}', 'completed', 'manual', now(), now(), '0' from generate_series(1, 1200) i`,
  sqlite: `with recursive n(i) as (select 1 union all select i + 1 from n where i < 1200) insert into workflow_executions (id, workflow_id, workflow_version_id, status, start_source, started_at, completed_at, duration) select '${workflowId}_run_' || i, '${workflowId}', '${versionId}', 'completed', 'manual', 0, 0, '0' from n`,
});

/** 700 audit rows naming no run, as Refused Starts write them. */
const bulkAudit = (workflowId: string) => ({
  postgresql: `insert into workflow_execution_events (id, workflow_id, event_type, message) select '${workflowId}_refused_' || i, '${workflowId}', 'run_refused', 'Refused' from generate_series(1, 700) i`,
  sqlite: `with recursive n(i) as (select 1 union all select i + 1 from n where i < 700) insert into workflow_execution_events (id, workflow_id, event_type, message, created_at) select '${workflowId}_refused_' || i, '${workflowId}', 'run_refused', 'Refused', 0 from n`,
});

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

    // A delivery step that runs again writes its decision's row again, so a
    // row with an id of its own is written once and its repeat is a no-op.
    it("writes an audit row with a given id once", async () => {
      const database = await openConnection();
      const events = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          const record = (message: string) =>
            executions.recordAuditEvent({
              id: "cancel_decision_1",
              workflowId: "wf_1",
              eventType: "cancel_not_delivered",
              message,
              metadata: { deliveryId: "delivery_1" },
            });
          yield* record("First");
          yield* record("Second");
          return yield* executions.listWorkflowEvents({
            workflowId: "wf_1",
            eventType: "cancel_not_delivered",
          });
        })
      );

      expect(events.map((event) => event.message)).toEqual(["First"]);
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
            eventName: "appointment/cancelled",
            payload: {},
            deliveryId: yield* cancelArrival(),
          });
          const exited = yield* executions.endRun({
            executionId: started.execution.id,
            ending: verdict("completed"),
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
            exited,
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
      expect(result.exited).toEqual({ kind: "ended", status: "exited" });
      expect(result.afterTerminal).toMatchObject({
        status: "exited",
        claim: expectedClaim,
        didWrite: false,
      });
      expect(result.summary).toMatchObject({ status: "exited" });
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
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
            deliveryId: yield* cancelArrival(),
          });
          const exit = yield* executions.requestExit({
            executionId: started.execution.id,
            reason: "entity_condition_not_met",
            nodeId: "node_check",
          });
          return { cancel, exit };
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
    });

    it("never leaves an ended run without its terminal timeline entry, even when the database refuses that entry once", async () => {
      const store = await openDatabase();
      const database = await store.open();
      await seedPublishedWorkflow(database);
      const started = await attemptStart(database, {
        deliveryId: "delivery_terminal_entry",
      });
      if (started.status !== "started") {
        throw new Error("The run was refused");
      }
      const executionId = started.execution.id;
      // One attempt of the durable step that records the run's end. A refused
      // attempt fails the step, which the executor runs again.
      const recordCompletion = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        yield* recordVerdict({
          store: createDbWorkflowStore({
            executionId,
            reads: executions,
            writes: executions,
            logRows: [],
          }),
          executionId,
          verdict: verdict("completed"),
          output: null,
        });
      }).pipe(Effect.ignore);

      await store.execute(refuseEntry("run_completed"));
      try {
        await database.run(recordCompletion);
      } finally {
        await store.execute(acceptEntry("run_completed"));
      }
      await database.run(recordCompletion);

      const ended = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const events = yield* executions.listEvents(executionId);
          return {
            status: (yield* executions.findStatusById(executionId))?.status,
            terminalEntries: events.filter(
              (event) => event.eventType === "run_completed"
            ).length,
          };
        })
      );
      expect(ended).toEqual({ status: "completed", terminalEntries: 1 });
    });

    it("never leaves a canceled run without its run_cancelled entry, even when the database refuses that entry once", async () => {
      const store = await openDatabase();
      const database = await store.open();
      await seedPublishedWorkflow(database);
      const started = await attemptStart(database, {
        deliveryId: "delivery_cancel_entry",
      });
      if (started.status !== "started") {
        throw new Error("The run was refused");
      }
      const executionId = started.execution.id;
      const cancel = cancelInFlightRuns({
        workflowId: "wf_1",
        executionIds: [executionId],
        reason: "Canceled from the Runs view",
      }).pipe(Effect.provide(SilentAppLoggerLayer));

      await store.execute(refuseEntry("run_cancelled"));
      try {
        await database.run(cancel);
      } finally {
        await store.execute(acceptEntry("run_cancelled"));
      }
      const retried = await database.run(cancel);
      // The run already reads canceled, so this cancel writes no second entry.
      const repeated = await database.run(cancel);

      const ended = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const events = yield* executions.listEvents(executionId);
          return {
            status: (yield* executions.findStatusById(executionId))?.status,
            cancelled: events
              .filter((event) => event.eventType === "run_cancelled")
              .map(({ message, metadata }) => ({ message, metadata })),
          };
        })
      );
      expect(ended).toEqual({
        status: "canceled",
        cancelled: [{ message: "Canceled from the Runs view", metadata: {} }],
      });
      expect(retried.endedExecutionIds).toEqual([executionId]);
      expect(repeated.endedExecutionIds).toEqual([]);
    });

    it("never leaves a superseded run without its run_superseded entry, even when the database refuses that entry once", async () => {
      const store = await openDatabase();
      const database = await store.open();
      await seedPublishedWorkflow(database);
      const displaced = await database.run(startNewestWins("delivery_first"));
      if (displaced.status !== "started") {
        throw new Error("The first run was refused");
      }
      await store.execute(refuseEntry("run_superseded"));
      try {
        await database.run(Effect.ignore(startNewestWins("delivery_second")));
      } finally {
        await store.execute(acceptEntry("run_superseded"));
      }
      await database.run(startNewestWins("delivery_second"));

      const superseded = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const events = yield* executions.listEvents(displaced.executionId);
          return {
            status: (yield* executions.findStatusById(displaced.executionId))
              ?.status,
            entries: events
              .filter((event) => event.eventType === "run_superseded")
              .map(({ message, metadata }) => ({ message, metadata })),
          };
        })
      );
      expect(superseded).toEqual({
        status: "superseded",
        entries: [
          {
            message: "Superseded by a newer start from appointment/rescheduled",
            metadata: { eventName: "appointment/rescheduled" },
          },
        ],
      });
    });

    it("commits a paused workflow's ignored run with its run_ignored entry, and writes neither when the database refuses the entry", async () => {
      const store = await openDatabase();
      const database = await store.open();
      await seedPublishedWorkflow(database);
      const ignore = recordPausedRunIgnored({
        workflowId: "wf_1",
        workflowVersionId: "ver_1",
        startSource: "manual",
        runMode: "live",
        payload: {},
      });
      const readRuns = Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const rows = yield* executions.listByWorkflow({
          workflowId: "wf_1",
          includeSuperseded: true,
        });
        return yield* Effect.forEach(rows, (row) =>
          executions.listEvents(row.id).pipe(
            Effect.map((events) => ({
              status: row.status,
              ignored: events
                .filter((event) => event.eventType === "run_ignored")
                .map(({ message, metadata }) => ({ message, metadata })),
            }))
          )
        );
      });

      await store.execute(refuseEntry("run_ignored"));
      try {
        await database.run(Effect.ignore(ignore));
      } finally {
        await store.execute(acceptEntry("run_ignored"));
      }
      const afterRefusal = await database.run(readRuns);
      await database.run(ignore);
      const afterAccept = await database.run(readRuns);

      expect(afterRefusal).toEqual([]);
      expect(afterAccept).toEqual([
        {
          status: "completed",
          ignored: [
            {
              message: "Ignored manual run because workflow is paused",
              metadata: { reason: "workflow_paused", runMode: "live" },
            },
          ],
        },
      ]);
    });

    // The Intake model's `ExecutionAndScheduleTogether`: an open run always has
    // a schedule row, because one write inserts both, and a start Concurrency
    // refuses or displaces leaves no schedule row behind.
    it("opens a run with its schedule row and its opening entry, and leaves no schedule row or open park on a run it refuses or displaces", async () => {
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
          if (first.status !== "started") throw new Error("Start was refused");
          const firstId = first.execution.id;
          const firstPark = yield* executions.startWait({
            side: "started",
            executionId: firstId,
            workflowId: "wf_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            workflowVersionId: "ver_1",
            waitType: "event",
            resumeToken: "resume_first",
            subscribedEvents: ["appointment/approved"],
            metadata: { expression: "true" },
          });
          if (!firstPark) throw new Error("Wait was refused");
          const refused = yield* start({
            deliveryId: "delivery_2",
            concurrency: "first-wins",
          });
          const newer = yield* start({
            deliveryId: "delivery_3",
            concurrency: "newest-wins",
          });
          if (newer.status !== "started") throw new Error("Start was refused");
          const newerId = newer.execution.id;
          return {
            refused,
            superseded: newer.supersededExecutionIds,
            firstPark: yield* executions.findPark(firstPark.waitStateId),
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
      expect(result.firstPark).toMatchObject({ status: "cancelled" });
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

    // Both backends fold a name's ASCII letters alone, whatever locale the
    // database was created with, so two names differing only in the case of
    // an accented letter are two names on either.
    it("folds only ASCII letters when it compares workflow names", async () => {
      const database = await openConnection();
      const answers = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Équipe",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insert({
            id: "wf_2",
            name: "équipe",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          return {
            upper: yield* workflows.hasWithName("ÉQUIPE"),
            lower: yield* workflows.hasWithName("éQUIPE"),
            other: yield* workflows.hasOtherWithName({
              name: "ÉQUIPE",
              excludingWorkflowId: "wf_1",
            }),
            absent: yield* workflows.hasWithName("Equipe"),
          };
        })
      );

      expect(answers).toEqual({
        upper: true,
        lower: true,
        other: false,
        absent: false,
      });
      await expect(
        database.run(
          Effect.flatMap(WorkflowRepo, (workflows) =>
            workflows.insert({
              id: "wf_3",
              name: "ÉQUIPE",
              graph: emptyGraph,
              eventSubscriptions: [],
            })
          )
        )
      ).rejects.toBeDefined();
    });

    it("reads each of a run's log rows with its id, status and opening time", async () => {
      const database = await openConnection();
      await seedPublishedWorkflow(database);

      const result = await database.run(
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
            ...notYetDue,
          });
          if (start.status !== "started") throw new Error("Start was refused");
          const executionId = start.execution.id;
          const before = Date.now();
          const open = (nodeId: string) =>
            executions.openNodeLog({
              executionId,
              nodeId,
              nodeName: nodeId,
              nodeType: "action",
            });
          const sent = yield* open("send");
          const waiting = yield* open("pause");
          yield* executions.closeNodeLog({
            logId: sent,
            status: "success",
            durationMs: 3,
          });
          return {
            before,
            after: Date.now(),
            sent,
            waiting,
            states: yield* executions.listNodeLogStates(executionId),
            none: yield* executions.listNodeLogStates("exec_unknown"),
          };
        })
      );

      expect(
        sortBy(result.states, [(state) => state.id]).map(({ id, status }) => ({
          id,
          status,
        }))
      ).toEqual(
        sortBy(
          [
            { id: result.sent, status: "success" },
            { id: result.waiting, status: "running" },
          ],
          [(state) => state.id]
        )
      );
      for (const state of result.states) {
        expect(state.startedAt).toBeInstanceOf(Date);
        expect(state.startedAt.getTime()).toBeGreaterThanOrEqual(
          result.before - 1_000
        );
        expect(state.startedAt.getTime()).toBeLessThanOrEqual(
          result.after + 1_000
        );
      }
      expect(result.none).toEqual([]);
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
          const finished = yield* executions.endRun({
            executionId,
            ending: verdict("canceled"),
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
      expect(result.finished).toEqual({ kind: "ended", status: "canceled" });
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
        {
          eventType: "run_cancelled",
          message: "Run canceled at the Canceled outlet",
        },
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

    it("holds a run's status and its node log's status to the words a write stores", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const started = await attemptStart(connection, {
        deliveryId: "delivery_1",
      });
      if (started.status !== "started") throw new Error("Start was refused");
      const executionId = started.execution.id;
      const logId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.openNodeLog({
            executionId,
            nodeId: "node_1",
            nodeName: "Create task",
            nodeType: "action",
          });
        })
      );
      const run = `id = '${executionId}'`;
      const log = `id = '${logId}'`;

      // No write ever stored `pending`, so a run cannot hold it.
      await expect(
        database.execute(
          `update workflow_executions set status = 'pending' where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set status = 'paused' where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_execution_logs set status = 'skipped' where ${log}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set run_mode = 'staging' where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set start_source = 'webhook' where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set status = 'waiting', waiting_at = started_at where ${run}`
        )
      ).resolves.toBeUndefined();
      await expect(
        database.execute(
          `update workflow_execution_logs set status = 'success' where ${log}`
        )
      ).resolves.toBeUndefined();
    });

    // The retention sweep finds an ended run by `completed_at`, and the Runs
    // view reads `waiting_at` and `cancelled_at` beside the status, so each
    // timestamp is set exactly while its status holds.
    it("holds a run's ending timestamps to its status", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const started = await attemptStart(connection, {
        deliveryId: "delivery_1",
      });
      if (started.status !== "started") throw new Error("Start was refused");
      const run = `id = '${started.execution.id}'`;
      const refused = [
        "set status = 'completed'",
        "set completed_at = started_at",
        "set status = 'waiting'",
        "set waiting_at = started_at",
        "set status = 'canceled', completed_at = started_at",
        "set cancelled_at = started_at",
        "set status = 'failed', completed_at = started_at, cancelled_at = started_at",
      ];
      for (const assignment of refused) {
        // eslint-disable-next-line eslint/no-await-in-loop -- each refusal is checked against the same row as it stands
        await expect(
          database.execute(
            `update workflow_executions ${assignment} where ${run}`
          ),
          assignment
        ).rejects.toThrow();
      }

      await connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.cancelRun({
            executionId: started.execution.id,
            reason: "Stopped by an operator",
          })
        )
      );
      const ended = await database.selectIds(
        `select id from workflow_executions where ${run} and status = 'canceled' and completed_at is not null and cancelled_at is not null and waiting_at is null`
      );
      expect(ended).toEqual([started.execution.id]);
    });

    // The cross-workflow list resumes after its last row by comparing that
    // row's start time, as the page answered it, with the stored one. Two runs
    // that started in the same instant are told apart by id, so neither may
    // fall between two pages.
    it("pages one run at a time across runs that started in the same instant", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      const opened: string[] = [];
      for (const deliveryId of ["delivery_1", "delivery_2", "delivery_3"]) {
        // eslint-disable-next-line eslint/no-await-in-loop -- each run opens after the one before it
        const started = await attemptStart(connection, { deliveryId });
        if (started.status !== "started") throw new Error("Start was refused");
        opened.push(started.execution.id);
      }
      const [first, second, third] = opened;
      // The second run takes the first run's stored start time as it stands,
      // whatever precision the column holds it at.
      await database.execute(
        `update workflow_executions set started_at = (select started_at from workflow_executions where id = '${first}') where id = '${second}'`
      );
      await setTimestamp(database, {
        table: "workflow_executions",
        column: "started_at",
        where: `id = '${third}'`,
        at: new Date("2000-01-01T00:00:00.000Z"),
      });

      const { paged, listed } = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const ids: string[] = [];
          let cursor: { startedAt: Date; id: string } | undefined;
          for (;;) {
            const [row] = yield* executions.listPage({ limit: 1, cursor });
            if (!row) break;
            ids.push(row.id);
            cursor = { startedAt: row.startedAt, id: row.id };
          }
          const rows = yield* executions.listByWorkflow({
            workflowId: "wf_1",
            includeSuperseded: false,
          });
          return { paged: ids, listed: rows.map((row) => row.id) };
        })
      );

      const tied = [first, second].toSorted().toReversed();
      expect(paged).toEqual([...tied, third]);
      expect(listed).toEqual([...tied, third]);
    });

    // The Runs view's poll counts superseded runs on every tick, and they
    // accrue without bound on a newest-wins workflow, so the count stops at
    // the bound its caller names.
    it("counts a workflow's superseded runs up to the bound it is given", async () => {
      const connection = await openConnection();
      await seedPublishedWorkflow(connection);
      for (const deliveryId of ["d_1", "d_2", "d_3", "d_4"]) {
        // eslint-disable-next-line eslint/no-await-in-loop -- each start supersedes the run before it
        const started = await attemptStart(connection, {
          deliveryId,
          concurrency: "newest-wins",
        });
        if (started.status !== "started") throw new Error("Start was refused");
      }

      const counts = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return {
            bounded: yield* executions.countSuperseded({
              workflowId: "wf_1",
              atMost: 2,
            }),
            unbounded: yield* executions.countSuperseded({
              workflowId: "wf_1",
              atMost: 10,
            }),
            listed: yield* executions.listByWorkflow({
              workflowId: "wf_1",
              includeSuperseded: false,
            }),
          };
        })
      );

      expect(counts.bounded).toBe(2);
      expect(counts.unbounded).toBe(3);
      expect(counts.listed.map((row) => row.status)).toEqual(["running"]);
    });

    // A workflow's history is cleared in bounded batches, each a transaction
    // of its own, and the clear goes on until no batch is full. The bulk rows
    // come from SQL, since 1,200 runs through the repository would make this
    // case the slowest in the file.
    it("clears a run history longer than one batch, and deletes a workflow with one", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      await seedPublishedWorkflow(connection);
      await seedPublishedWorkflow(connection, {
        workflowId: "wf_2",
        name: "Reminders",
        versionId: "ver_2",
      });
      await database.execute(bulkRuns("wf_1", "ver_1"));
      await database.execute(bulkAudit("wf_1"));
      await database.execute(bulkRuns("wf_2", "ver_2"));
      await database.execute(bulkAudit("wf_2"));
      // One run of each workflow holds a schedule row, which a batch locks
      // before the run.
      for (const workflowId of ["wf_1", "wf_2"]) {
        // eslint-disable-next-line eslint/no-await-in-loop -- one start per workflow
        const started = await attemptStart(connection, {
          deliveryId: `delivery_${workflowId}`,
          workflowId,
          versionId: workflowId === "wf_1" ? "ver_1" : "ver_2",
        });
        if (started.status !== "started") throw new Error("Start was refused");
      }
      const remaining = (workflowId: string) =>
        Promise.all([
          database.selectIds(
            `select id from workflow_executions where workflow_id = '${workflowId}'`
          ),
          database.selectIds(
            `select id from workflow_execution_events where workflow_id = '${workflowId}'`
          ),
        ]).then(([runs, audit]) => ({
          runs: runs.length,
          audit: audit.length,
        }));

      const cleared = await connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.deleteAllForWorkflow("wf_1")
        )
      );

      expect(cleared).toBe(1201);
      expect(await remaining("wf_1")).toEqual({ runs: 0, audit: 0 });
      expect(await remaining("wf_2")).toEqual({ runs: 1201, audit: 701 });

      await connection.run(
        Effect.flatMap(WorkflowRepo, (workflows) =>
          workflows.deleteById("wf_2")
        )
      );

      expect(await remaining("wf_2")).toEqual({ runs: 0, audit: 0 });
      expect(
        await connection.run(
          Effect.flatMap(WorkflowRepo, (workflows) =>
            workflows.findById("wf_2")
          )
        )
      ).toBeNull();
      expect(
        await connection.run(
          Effect.flatMap(WorkflowRepo, (workflows) =>
            workflows.findById("wf_1")
          )
        )
      ).not.toBeNull();
    });
  });
}
