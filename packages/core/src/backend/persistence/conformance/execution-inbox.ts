/**
 * The executions aggregate's event inbox: what an arrival writes, which resend
 * is a duplicate, what the poll schedules, how a delivery settles under its
 * owner token, and what the retention sweep deletes.
 *
 * A case that settles a delivery leases its schedule row with one SQL update
 * that sets the owner token, so the case holds a fence with a token it chose.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  type DeliveryFence,
  ExecutionRepo,
  type NewInboxEvent,
} from "#src/backend/services/executions/repo";
import type {
  CaseDatabase,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  at,
  refusalOf,
} from "#src/backend/persistence/conformance/schedule-support";

const BOOKED = "appointment/booked";

/** An arrival of `appointment/booked` with the key and Connection given. */
function arrival(
  idempotencyKey: string | null,
  connectionId: string | null = null
): NewInboxEvent {
  return {
    name: BOOKED,
    data: { appointmentId: "appt_1", slot: { day: "monday", hour: 9 } },
    connectionId,
    idempotencyKey,
  };
}

function send(input: NewInboxEvent, now: Date = T0) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    return yield* executions.insertInboxEvent({ ...input, now });
  });
}

/** Sends one new arrival and answers its fence's two ids. */
function sendNew(input: NewInboxEvent, now: Date = T0) {
  return send(input, now).pipe(
    Effect.map((inserted) => {
      if (inserted.duplicate) throw new Error("The arrival was a duplicate");
      return { inboxId: inserted.inboxId, scheduleId: inserted.scheduleId };
    })
  );
}

/**
 * Leases a delivery's schedule row under `ownerToken`, standing in for the
 * claim, and answers the fence a pass holding that lease carries.
 */
async function leaseDelivery(
  database: CaseDatabase,
  delivery: { inboxId: string; scheduleId: string },
  ownerToken: string
): Promise<DeliveryFence> {
  await database.execute(
    `update workflow_execution_schedule set state = 'leased', owner_token = '${ownerToken}' where id = '${delivery.scheduleId}'`
  );
  return { ...delivery, ownerToken };
}

/** Records one succeeded step in a delivery's memo, as a pass would. */
function memoStep(database: CaseDatabase, scheduleId: string) {
  const columns = `schedule_id, step_id, status, value`;
  const values = `'${scheduleId}', 'subscribers-0', 'succeeded', '1'`;
  return database.execute({
    postgresql: `insert into workflow_execution_steps (${columns}) values (${values})`,
    sqlite: `insert into workflow_execution_steps (${columns}, created_at) values (${values}, 0)`,
  });
}

/** The insert a host makes in its own transaction, as `workflowEventInbox` documents it. */
function hostInsert(input: {
  id?: string | undefined;
  idempotencyKey: string | null;
}): string {
  const key =
    input.idempotencyKey === null ? "null" : `'${input.idempotencyKey}'`;
  return input.id === undefined
    ? `insert into workflow_event_inbox (name, data, idempotency_key, connection_id) values ('${BOOKED}', '{"appointmentId":"appt_9"}', ${key}, null) on conflict do nothing`
    : `insert into workflow_event_inbox (id, name, data, idempotency_key, connection_id) values ('${input.id}', '${BOOKED}', '{"appointmentId":"appt_9"}', ${key}, null) on conflict do nothing`;
}

export function describeExecutionInboxConformance({
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("event inbox", () => {
    it("records an arrival with its delivery schedule row, and answers a resend with the same name, Connection and key as a duplicate", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const first = yield* sendNew(arrival("vendor_1"));
          return {
            first,
            event: yield* executions.findInboxEvent(first.inboxId),
            schedule: yield* executions.findSchedule({
              inboxId: first.inboxId,
            }),
            resent: yield* send(arrival("vendor_1"), at(1_000)),
            otherConnection: yield* send(arrival("vendor_1", "conn_a")),
            otherConnectionResent: yield* send(arrival("vendor_1", "conn_a")),
            secondConnection: yield* send(arrival("vendor_1", "conn_b")),
            otherName: yield* send({
              ...arrival("vendor_1"),
              name: "appointment/canceled",
            }),
            unkeyed: [yield* send(arrival(null)), yield* send(arrival(null))],
          };
        })
      );

      expect(result.event).toEqual({
        id: result.first.inboxId,
        ...arrival("vendor_1"),
        receivedAt: T0,
        status: "pending",
      });
      expect(result.schedule).toMatchObject({
        id: result.first.scheduleId,
        kind: "delivery",
        executionId: null,
        inboxId: result.first.inboxId,
        state: "queued",
        wakeAt: T0,
        ownerToken: null,
      });
      expect(result.resent).toEqual({
        duplicate: true,
        inboxId: result.first.inboxId,
      });

      // Two Connections receiving the same vendor id are two arrivals, and a
      // Connection's own resend is a duplicate of its first.
      expect(result.otherConnection.duplicate).toBe(false);
      expect(result.otherConnectionResent).toEqual({
        duplicate: true,
        inboxId: result.otherConnection.inboxId,
      });
      expect(result.secondConnection.duplicate).toBe(false);
      expect(result.otherName.duplicate).toBe(false);
      expect(
        new Set([
          result.first.inboxId,
          result.otherConnection.inboxId,
          result.secondConnection.inboxId,
          result.otherName.inboxId,
        ]).size
      ).toBe(4);

      // An arrival with no key is never a duplicate.
      expect(result.unkeyed.map((sent) => sent.duplicate)).toEqual([
        false,
        false,
      ]);
      expect(result.unkeyed[0]?.inboxId).not.toBe(result.unkeyed[1]?.inboxId);
    });

    it("records one arrival when two connections send the same key at once", async () => {
      const database = await openDatabase();
      const first = await database.open();
      const second = await database.open();

      const sent = await Promise.all([
        first.run(send(arrival("vendor_1"))),
        second.run(send(arrival("vendor_1"))),
      ]);

      expect(sent.filter((one) => one.duplicate)).toHaveLength(1);
      expect(sent[0]?.inboxId).toBe(sent[1]?.inboxId);
    });

    it("writes no schedule row for a duplicate, even once the first arrival's delivery has settled", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const first = await connection.run(sendNew(arrival("vendor_1")));
      const fence = await leaseDelivery(database, first, "owner_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.finishDelivery({ fence, now: at(2_000) });
          const resent = yield* send(arrival("vendor_1"), at(3_000));
          return {
            resent,
            schedule: yield* executions.findSchedule({
              inboxId: first.inboxId,
            }),
            event: yield* executions.findInboxEvent(first.inboxId),
            scheduledByPoll: yield* executions.scheduleUnscheduledInbox({
              now: at(4_000),
              limit: 10,
            }),
          };
        })
      );

      expect(result.resent).toEqual({
        duplicate: true,
        inboxId: first.inboxId,
      });
      expect(result.schedule).toBeNull();
      expect(result.event).toMatchObject({
        status: "delivered",
        settledAt: at(2_000),
      });
      expect(result.scheduledByPoll).toEqual([]);
    });

    it("reopens a failed row for a resend of its key, scheduling it again once, and keeps its id and data", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const first = await connection.run(sendNew(arrival("vendor_1")));
      const fence = await leaseDelivery(database, first, "owner_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.failDelivery({
            fence,
            error: "The subscriber step failed",
            now: at(2_000),
          });
          const resent = yield* send(
            { ...arrival("vendor_1"), data: { appointmentId: "appt_2" } },
            at(3_000)
          );
          return {
            resent,
            event: yield* executions.findInboxEvent(first.inboxId),
            schedule: yield* executions.findSchedule({
              inboxId: first.inboxId,
            }),
            // A pending row answers a second resend as a duplicate.
            resentAgain: yield* send(arrival("vendor_1"), at(4_000)),
            scheduledByPoll: yield* executions.scheduleUnscheduledInbox({
              now: at(5_000),
              limit: 10,
            }),
          };
        })
      );

      if (result.resent.duplicate)
        throw new Error("The resend was a duplicate");
      expect(result.resent.inboxId).toBe(first.inboxId);
      expect(result.resent.scheduleId).not.toBe(first.scheduleId);
      expect(result.event).toEqual({
        id: first.inboxId,
        ...arrival("vendor_1"),
        receivedAt: T0,
        status: "pending",
      });
      expect(result.schedule).toMatchObject({
        id: result.resent.scheduleId,
        kind: "delivery",
        state: "queued",
        wakeAt: at(3_000),
        ownerToken: null,
      });
      expect(result.resentAgain).toEqual({
        duplicate: true,
        inboxId: first.inboxId,
      });
      expect(result.scheduledByPoll).toEqual([]);
    });

    it("schedules a row a host inserted through SQL once, and skips scheduled, delivered and failed rows", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const sent = await connection.run(
        Effect.gen(function* () {
          return {
            scheduled: yield* sendNew(arrival("scheduled")),
            delivered: yield* sendNew(arrival("delivered")),
            failed: yield* sendNew(arrival("failed")),
          };
        })
      );
      const deliveredFence = await leaseDelivery(
        database,
        sent.delivered,
        "owner_d"
      );
      const failedFence = await leaseDelivery(database, sent.failed, "owner_f");
      await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.finishDelivery({
            fence: deliveredFence,
            now: at(1_000),
          });
          yield* executions.failDelivery({
            fence: failedFence,
            error: "The subscriber step failed",
            now: at(1_000),
          });
        })
      );

      // The documented statement, twice for one key: the second is a no-op.
      await database.execute(hostInsert({ id: "host_1", idempotencyKey: "h" }));
      await database.execute(hostInsert({ id: "host_2", idempotencyKey: "h" }));
      await database.execute(hostInsert({ idempotencyKey: null }));

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const hostRow = yield* executions.findInboxEvent("host_1");
          const firstPoll = yield* executions.scheduleUnscheduledInbox({
            now: at(5_000),
            limit: 1,
          });
          const secondPoll = yield* executions.scheduleUnscheduledInbox({
            now: at(6_000),
            limit: 10,
          });
          const thirdPoll = yield* executions.scheduleUnscheduledInbox({
            now: at(7_000),
            limit: 10,
          });
          return {
            hostRow,
            refusedHostRow: yield* executions.findInboxEvent("host_2"),
            firstPoll,
            secondPoll,
            thirdPoll,
            hostSchedule: yield* executions.findSchedule({
              inboxId: "host_1",
            }),
            failedEvent: yield* executions.findInboxEvent(sent.failed.inboxId),
            failedSchedule: yield* executions.findSchedule({
              inboxId: sent.failed.inboxId,
            }),
          };
        })
      );

      expect(result.hostRow).toMatchObject({
        id: "host_1",
        name: BOOKED,
        data: { appointmentId: "appt_9" },
        connectionId: null,
        idempotencyKey: "h",
        status: "pending",
      });
      expect(result.hostRow?.receivedAt).toBeInstanceOf(Date);
      expect(result.refusedHostRow).toBeNull();

      // The poll took the host's two rows, one per call at a limit of one,
      // and left the sent, delivered and failed rows alone.
      expect(result.firstPoll).toHaveLength(1);
      expect(result.secondPoll).toHaveLength(1);
      const polled = [...result.firstPoll, ...result.secondPoll];
      expect(polled.map((row) => row.inboxId)).toContain("host_1");
      expect(
        polled.map((row) => row.inboxId).filter((id) => id !== "host_1")
      ).toHaveLength(1);
      expect(result.thirdPoll).toEqual([]);
      expect(result.hostSchedule).toMatchObject({
        kind: "delivery",
        inboxId: "host_1",
        executionId: null,
        state: "queued",
      });
      expect(result.failedEvent).toMatchObject({
        status: "failed",
        error: "The subscriber step failed",
        settledAt: at(1_000),
      });
      expect(result.failedSchedule).toBeNull();
    });

    it("refuses a settling write under a stale owner token, and settles under the current one with the schedule row and its memo", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const { first, second } = await connection.run(
        Effect.gen(function* () {
          return {
            first: yield* sendNew(arrival("vendor_1")),
            second: yield* sendNew(arrival("vendor_2")),
          };
        })
      );
      const stale = await leaseDelivery(database, first, "owner_1");
      const current = await leaseDelivery(database, first, "owner_2");
      const otherFence = await leaseDelivery(database, second, "owner_3");
      await memoStep(database, first.scheduleId);

      const refused = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return {
            finish: yield* refusalOf(
              executions.finishDelivery({ fence: stale, now: at(1_000) })
            ),
            fail: yield* refusalOf(
              executions.failDelivery({
                fence: stale,
                error: "stale",
                now: at(1_000),
              })
            ),
            // The right token on a schedule row that delivers another arrival.
            crossed: yield* refusalOf(
              executions.finishDelivery({
                fence: { ...otherFence, inboxId: first.inboxId },
                now: at(1_000),
              })
            ),
            event: yield* executions.findInboxEvent(first.inboxId),
            schedule: yield* executions.findSchedule({
              inboxId: first.inboxId,
            }),
            memo: yield* executions.listStepMemo({
              scheduleId: first.scheduleId,
            }),
          };
        })
      );
      expect(refused.finish).toBe("LeaseLost");
      expect(refused.fail).toBe("LeaseLost");
      expect(refused.crossed).toBe("LeaseLost");
      expect(refused.event?.status).toBe("pending");
      expect(refused.schedule).toMatchObject({
        state: "leased",
        ownerToken: "owner_2",
      });
      expect(refused.memo).toHaveLength(1);

      const settled = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* executions.finishDelivery({ fence: current, now: at(2_000) });
          yield* executions.failDelivery({
            fence: otherFence,
            error: "The subscriber step failed",
            now: at(2_000),
          });
          return {
            finishedAgain: yield* refusalOf(
              executions.finishDelivery({ fence: current, now: at(3_000) })
            ),
            first: yield* executions.findInboxEvent(first.inboxId),
            second: yield* executions.findInboxEvent(second.inboxId),
            schedule: yield* executions.findSchedule({
              scheduleId: first.scheduleId,
            }),
            memo: yield* executions.listStepMemo({
              scheduleId: first.scheduleId,
            }),
          };
        })
      );
      expect(settled.first).toMatchObject({
        status: "delivered",
        settledAt: at(2_000),
      });
      expect(settled.second).toMatchObject({
        status: "failed",
        error: "The subscriber step failed",
        settledAt: at(2_000),
      });
      expect(settled.schedule).toBeNull();
      expect(settled.memo).toEqual([]);
      expect(settled.finishedAgain).toBe("LeaseLost");
    });

    it("sweeps settled rows that arrived before the window, a batch at a time, and never a pending one", async () => {
      const database = await openDatabase();
      const connection = await database.open();
      const sent = await connection.run(
        Effect.gen(function* () {
          return {
            oldDelivered: yield* sendNew(arrival("old_delivered"), T0),
            oldFailed: yield* sendNew(arrival("old_failed"), at(1_000)),
            oldPending: yield* sendNew(arrival("old_pending"), T0),
            newDelivered: yield* sendNew(
              arrival("new_delivered"),
              at(7_200_000)
            ),
          };
        })
      );
      const fences = {
        oldDelivered: await leaseDelivery(database, sent.oldDelivered, "o_1"),
        oldFailed: await leaseDelivery(database, sent.oldFailed, "o_2"),
        newDelivered: await leaseDelivery(database, sent.newDelivered, "o_3"),
      };

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const now = at(7_300_000);
          yield* executions.finishDelivery({ fence: fences.oldDelivered, now });
          yield* executions.failDelivery({
            fence: fences.oldFailed,
            error: "The subscriber step failed",
            now,
          });
          yield* executions.finishDelivery({ fence: fences.newDelivered, now });

          const window = { olderThan: at(3_600_000) };
          const firstSweep = yield* executions.sweepSettledInbox({
            ...window,
            limit: 1,
          });
          const afterFirstSweep = yield* executions.findInboxEvent(
            sent.oldFailed.inboxId
          );
          const sweeps = [
            firstSweep,
            yield* executions.sweepSettledInbox({ ...window, limit: 10 }),
            yield* executions.sweepSettledInbox({ ...window, limit: 10 }),
          ];
          const remaining = {
            oldDelivered: yield* executions.findInboxEvent(
              sent.oldDelivered.inboxId
            ),
            oldFailed: yield* executions.findInboxEvent(sent.oldFailed.inboxId),
            oldPending: yield* executions.findInboxEvent(
              sent.oldPending.inboxId
            ),
            newDelivered: yield* executions.findInboxEvent(
              sent.newDelivered.inboxId
            ),
          };
          return {
            sweeps,
            afterFirstSweep,
            remaining,
            pendingSchedule: yield* executions.findSchedule({
              inboxId: sent.oldPending.inboxId,
            }),
            // A swept row's key is accepted again as a new arrival.
            resent: yield* send(arrival("old_delivered"), at(7_400_000)),
          };
        })
      );

      // The oldest settled row went first, under the limit of one.
      expect(result.sweeps).toEqual([1, 1, 0]);
      expect(result.afterFirstSweep?.status).toBe("failed");
      expect(result.remaining.oldDelivered).toBeNull();
      expect(result.remaining.oldFailed).toBeNull();
      expect(result.remaining.oldPending?.status).toBe("pending");
      expect(result.remaining.newDelivered?.status).toBe("delivered");
      expect(result.pendingSchedule?.kind).toBe("delivery");
      expect(result.resent.duplicate).toBe(false);
    });
  });
}
