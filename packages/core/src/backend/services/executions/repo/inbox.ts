/**
 * The `workflow_event_inbox` slice of `ExecutionRepo` over PostgreSQL: an
 * arrival's inbox row, its `delivery` schedule row, and how a delivery
 * settles. `inbox-policy.ts` makes the decisions; this file runs the
 * statements. A settling write takes the delivery's schedule row before its
 * inbox row, the order every fenced write takes a schedule row first.
 */

import { asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import {
  workflowEventInbox,
  workflowExecutionSchedule,
} from "#src/backend/lib/db/schema";
import type { WfGraphTransaction } from "#src/backend/lib/db/index";
import { deleteOldestBatch } from "#src/backend/lib/db/batched-delete";
import type {
  Database,
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type {
  DeliveryFence,
  InboxEvent,
  InboxInsert,
  NewInboxEvent,
  ScheduledDelivery,
} from "#src/backend/services/executions/repo/contracts";
import {
  awaitsSchedule,
  holdsInboxKey,
  inboxEventOf,
  resendOnHeldKey,
  settleableInbox,
  sweepableInbox,
} from "#src/backend/services/executions/repo/inbox-policy";
import { writeFenced } from "#src/backend/services/executions/repo/schedule";
import { generateId } from "@wfgraph/shared/utils/id";

/** The event inbox slice of `ExecutionRepo`. */
export type InboxRepoMethods = {
  /**
   * Record an arrival in one transaction, as `writeArrival` describes. The
   * caller wakes the worker loops once an answer that is not a duplicate has
   * committed.
   */
  readonly insertInboxEvent: (
    input: NewInboxEvent & { now: Date }
  ) => Effect.Effect<InboxInsert, DatabaseError>;
  /**
   * The poll: give up to `limit` `pending` inbox rows the executor has never
   * scheduled a `delivery` schedule row, due at `now`, oldest arrival first,
   * and mark each as scheduled at `now`. A row a host inserted through the SQL
   * contract at `workflowEventInbox` starts this way. Answers the rows it
   * scheduled.
   */
  readonly scheduleUnscheduledInbox: (input: {
    now: Date;
    limit: number;
  }) => Effect.Effect<ScheduledDelivery[], DatabaseError>;
  /**
   * Settle a delivery that ran to the end: its inbox row becomes `delivered`
   * at `now`, and its schedule row is deleted with its step memo, in one
   * transaction fenced on the pass's owner token.
   */
  readonly finishDelivery: (input: {
    fence: DeliveryFence;
    now: Date;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * Settle a delivery that failed for good: its inbox row becomes `failed`
   * with `error` at `now`, and its schedule row is deleted with its step
   * memo, in one transaction fenced on the pass's owner token. The poll never
   * schedules a `failed` row again.
   */
  readonly failDelivery: (input: {
    fence: DeliveryFence;
    error: string;
    now: Date;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * The retention sweep: delete up to `limit` settled inbox rows, `delivered`
   * or `failed`, that arrived before `olderThan`, oldest first, answering how
   * many went, with each row's Cancel decisions by cascade. A `pending` row is
   * never deleted. Once a row is gone, its idempotency key is accepted again as
   * a new arrival.
   */
  readonly sweepSettledInbox: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
  /** One inbox row, or null when there is none. */
  readonly findInboxEvent: (
    inboxId: string
  ) => Effect.Effect<InboxEvent | null, DatabaseError>;
};

/** Gives one inbox row its `delivery` schedule row, `queued` and due at `wakeAt`. */
async function insertDeliverySchedule(
  tx: WfGraphTransaction,
  input: { inboxId: string; wakeAt: Date }
): Promise<string> {
  const [schedule] = await tx
    .insert(workflowExecutionSchedule)
    .values({
      kind: "delivery",
      inboxId: input.inboxId,
      state: "queued",
      wakeAt: input.wakeAt,
    })
    .returning({ id: workflowExecutionSchedule.id });
  if (!schedule) {
    throw new Error("PostgreSQL returned no delivery schedule row");
  }
  return schedule.id;
}

/**
 * One attempt at recording an arrival, as `writeArrival` describes. Answers
 * null when the insert met a row holding the arrival's key and that row was
 * gone by the time this read it, which the retention sweep does between the
 * two statements.
 */
async function insertOrResend(
  tx: WfGraphTransaction,
  input: NewInboxEvent & { now: Date }
): Promise<InboxInsert | null> {
  const inboxId = generateId();
  // The inbox id is minted here, so the only unique index a new row can meet
  // is the idempotency key's.
  const [inserted] = await tx
    .insert(workflowEventInbox)
    .values({
      id: inboxId,
      name: input.name,
      data: input.data,
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey,
      receivedAt: input.now,
      scheduledAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: workflowEventInbox.id });
  if (inserted) {
    const scheduleId = await insertDeliverySchedule(tx, {
      inboxId,
      wakeAt: input.now,
    });
    return { duplicate: false, inboxId, scheduleId };
  }

  const { idempotencyKey } = input;
  if (idempotencyKey === null) {
    throw new Error("An inbox insert with no idempotency key conflicted");
  }
  // The row lock orders two resends of one failed row: the second reads the
  // row the first reopened, and answers it as a duplicate.
  const [held] = await tx
    .select({ id: workflowEventInbox.id, status: workflowEventInbox.status })
    .from(workflowEventInbox)
    .where(holdsInboxKey(workflowEventInbox, { ...input, idempotencyKey }))
    .for("update");
  if (!held) return null;
  if (resendOnHeldKey(held.status) === "duplicate") {
    return { duplicate: true, inboxId: held.id };
  }
  await tx
    .update(workflowEventInbox)
    .set({
      status: "pending",
      error: null,
      settledAt: null,
      scheduledAt: input.now,
    })
    .where(eq(workflowEventInbox.id, held.id));
  const scheduleId = await insertDeliverySchedule(tx, {
    inboxId: held.id,
    wakeAt: input.now,
  });
  return { duplicate: false, inboxId: held.id, scheduleId };
}

/**
 * Records an arrival inside the caller's transaction: its inbox row and its
 * `delivery` schedule row, `queued` and due at `now`. When an inbox row
 * already holds the arrival's idempotency key, for the same Event name and
 * Connection, a `failed` row is reopened as `pending`, with its error and
 * settled time cleared, and given a new schedule row, keeping its id and its
 * data; a `pending` or `delivered` row writes nothing and is answered as a
 * duplicate. When the row holding the key is swept between the insert and the
 * read, the insert runs once more.
 */
export async function writeArrival(
  tx: WfGraphTransaction,
  input: NewInboxEvent & { now: Date }
): Promise<InboxInsert> {
  const written =
    (await insertOrResend(tx, input)) ?? (await insertOrResend(tx, input));
  if (written === null) {
    throw new Error(
      "An inbox insert conflicted twice, and no row holds its idempotency key"
    );
  }
  return written;
}

/** Builds the event inbox slice of `ExecutionRepo` over one database. */
export function makeInboxMethods(
  database: Database["Service"]
): InboxRepoMethods {
  const settle = (
    fence: DeliveryFence,
    settled: { status: "delivered" | "failed"; error: string | null; now: Date }
  ) =>
    writeFenced(
      database,
      fence,
      async (tx) => {
        await tx
          .update(workflowEventInbox)
          .set({
            status: settled.status,
            error: settled.error,
            settledAt: settled.now,
          })
          .where(settleableInbox(workflowEventInbox, fence.inboxId));
        // The memo rows go with the schedule row by cascade.
        await tx
          .delete(workflowExecutionSchedule)
          .where(eq(workflowExecutionSchedule.id, fence.scheduleId));
      },
      "update"
    );

  return {
    insertInboxEvent: (input) =>
      database.query((db) => db.transaction((tx) => writeArrival(tx, input))),

    scheduleUnscheduledInbox: (input) =>
      database.query((db) =>
        db.transaction(async (tx): Promise<ScheduledDelivery[]> => {
          // Two polls at once split the rows between them, and a row both
          // reach is scheduled once by the unique index on `inbox_id`.
          const awaiting = await tx
            .select({ id: workflowEventInbox.id })
            .from(workflowEventInbox)
            .where(awaitsSchedule(workflowEventInbox))
            .orderBy(
              asc(workflowEventInbox.receivedAt),
              asc(workflowEventInbox.id)
            )
            .limit(input.limit)
            .for("update", { skipLocked: true });
          if (awaiting.length === 0) return [];

          const scheduled = await tx
            .insert(workflowExecutionSchedule)
            .values(
              awaiting.map((row) => ({
                kind: "delivery" as const,
                inboxId: row.id,
                state: "queued" as const,
                wakeAt: input.now,
              }))
            )
            .onConflictDoNothing({ target: workflowExecutionSchedule.inboxId })
            .returning({
              scheduleId: workflowExecutionSchedule.id,
              inboxId: workflowExecutionSchedule.inboxId,
            });
          // Every row taken is marked, including one a schedule row already
          // named, which only a row written before the marker existed is.
          await tx
            .update(workflowEventInbox)
            .set({ scheduledAt: input.now })
            .where(
              inArray(
                workflowEventInbox.id,
                awaiting.map((row) => row.id)
              )
            );
          return scheduled.flatMap((row) =>
            row.inboxId === null
              ? []
              : [{ scheduleId: row.scheduleId, inboxId: row.inboxId }]
          );
        })
      ),

    finishDelivery: (input) =>
      settle(input.fence, { status: "delivered", error: null, now: input.now }),

    failDelivery: (input) =>
      settle(input.fence, {
        status: "failed",
        error: input.error,
        now: input.now,
      }),

    sweepSettledInbox: (input) =>
      database.query((db) =>
        deleteOldestBatch(db, {
          table: workflowEventInbox,
          id: workflowEventInbox.id,
          where: sweepableInbox(workflowEventInbox, input.olderThan),
          oldestFirst: workflowEventInbox.receivedAt,
          limit: input.limit,
        })
      ),

    findInboxEvent: (inboxId) =>
      database.query(async (db) => {
        const [row] = await db
          .select()
          .from(workflowEventInbox)
          .where(eq(workflowEventInbox.id, inboxId));
        return row === undefined ? null : inboxEventOf(row);
      }),
  };
}
