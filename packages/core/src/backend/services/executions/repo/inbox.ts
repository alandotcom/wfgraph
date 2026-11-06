/**
 * The `workflow_event_inbox` slice of `ExecutionRepo` over PostgreSQL: an
 * arrival's inbox row, its `delivery` schedule row, and how a delivery
 * settles. `inbox-policy.ts` makes the decisions; this file runs the
 * statements. A settling write takes the delivery's schedule row before its
 * inbox row, the order every fenced write takes a schedule row first.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import {
  workflowEventInbox,
  workflowExecutionSchedule,
} from "#src/backend/lib/db/schema";
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
  sweepableInbox,
} from "#src/backend/services/executions/repo/inbox-policy";
import { writeFenced } from "#src/backend/services/executions/repo/schedule";
import { generateId } from "@wfgraph/shared/utils/id";

/** The event inbox slice of `ExecutionRepo`. */
export type InboxRepoMethods = {
  /**
   * Record an arrival: its inbox row and its `delivery` schedule row, `queued`
   * and due at `now`, in one transaction. An arrival whose idempotency key an
   * inbox row already holds, for the same Event name and Connection, writes
   * nothing and is answered with that row's id. The caller wakes the worker
   * loops once a new arrival has committed.
   */
  readonly insertInboxEvent: (
    input: NewInboxEvent & { now: Date }
  ) => Effect.Effect<InboxInsert, DatabaseError>;
  /**
   * The poll: give up to `limit` `pending` inbox rows that have no schedule
   * row a `delivery` schedule row, due at `now`, oldest arrival first. A row
   * a host inserted through the SQL contract at `workflowEventInbox` starts
   * this way. Answers the rows it scheduled.
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
   * The retention sweep: delete up to `limit` settled inbox rows that arrived
   * before `olderThan`, oldest first, answering how many went. A `pending`
   * row is never deleted. Once a row is gone, its idempotency key is accepted
   * again as a new arrival.
   */
  readonly sweepDeliveredInbox: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
  /** One inbox row, or null when there is none. */
  readonly findInboxEvent: (
    inboxId: string
  ) => Effect.Effect<InboxEvent | null, DatabaseError>;
};

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
          .where(
            and(
              eq(workflowEventInbox.id, fence.inboxId),
              eq(workflowEventInbox.status, "pending")
            )
          );
        // The memo rows go with the schedule row by cascade.
        await tx
          .delete(workflowExecutionSchedule)
          .where(eq(workflowExecutionSchedule.id, fence.scheduleId));
      },
      "update"
    );

  return {
    insertInboxEvent: (input) =>
      database.query((db) =>
        db.transaction(async (tx): Promise<InboxInsert> => {
          const inboxId = generateId();
          // The inbox id is minted here, so the only unique index a new row
          // can meet is the idempotency key's.
          const [inserted] = await tx
            .insert(workflowEventInbox)
            .values({
              id: inboxId,
              name: input.name,
              data: input.data,
              connectionId: input.connectionId,
              idempotencyKey: input.idempotencyKey,
              receivedAt: input.now,
            })
            .onConflictDoNothing()
            .returning({ id: workflowEventInbox.id });
          if (inserted) {
            const [schedule] = await tx
              .insert(workflowExecutionSchedule)
              .values({
                kind: "delivery",
                inboxId,
                state: "queued",
                wakeAt: input.now,
              })
              .returning({ id: workflowExecutionSchedule.id });
            if (!schedule) {
              throw new Error("PostgreSQL returned no delivery schedule row");
            }
            return { duplicate: false, inboxId, scheduleId: schedule.id };
          }

          const { idempotencyKey } = input;
          const [existing] =
            idempotencyKey === null
              ? []
              : await tx
                  .select({ id: workflowEventInbox.id })
                  .from(workflowEventInbox)
                  .where(
                    holdsInboxKey(workflowEventInbox, {
                      ...input,
                      idempotencyKey,
                    })
                  );
          if (!existing) {
            throw new Error(
              "An inbox insert conflicted, and no row holds its idempotency key"
            );
          }
          return { duplicate: true, inboxId: existing.id };
        })
      ),

    scheduleUnscheduledInbox: (input) =>
      database.query((db) =>
        db.transaction(async (tx): Promise<ScheduledDelivery[]> => {
          // Two polls at once split the rows between them, and a row both
          // reach is scheduled once by the unique index on `inbox_id`.
          const awaiting = await tx
            .select({ id: workflowEventInbox.id })
            .from(workflowEventInbox)
            .where(
              awaitsSchedule(workflowEventInbox, {
                table: workflowExecutionSchedule,
                inboxId: workflowExecutionSchedule.inboxId,
              })
            )
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

    sweepDeliveredInbox: (input) =>
      database.query(async (db) => {
        const swept = await db
          .delete(workflowEventInbox)
          .where(
            inArray(
              workflowEventInbox.id,
              db
                .select({ id: workflowEventInbox.id })
                .from(workflowEventInbox)
                .where(sweepableInbox(workflowEventInbox, input.olderThan))
                .orderBy(asc(workflowEventInbox.receivedAt))
                .limit(input.limit)
            )
          )
          .returning({ id: workflowEventInbox.id });
        return swept.length;
      }),

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
