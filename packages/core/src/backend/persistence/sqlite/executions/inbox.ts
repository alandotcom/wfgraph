/**
 * The event inbox slice of the SQLite `ExecutionRepo`, as `InboxRepoMethods`
 * in `repo/inbox.ts` describes it. Every write runs in one `BEGIN IMMEDIATE`
 * transaction, which holds the one writer from its first statement, so the
 * poll needs no `SKIP LOCKED` and a fence check needs no row lock.
 */

import { Effect } from "effect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import type {
  DeliveryFence,
  InboxInsert,
} from "#src/backend/services/executions/repo/contracts";
import type { InboxRepoMethods } from "#src/backend/services/executions/repo/inbox";
import {
  awaitsSchedule,
  holdsInboxKey,
  inboxEventOf,
  sweepableInbox,
} from "#src/backend/services/executions/repo/inbox-policy";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  workflowEventInbox,
  workflowExecutionSchedule,
} from "#src/backend/persistence/sqlite/schema";
import { writeFenced } from "#src/backend/persistence/sqlite/executions/schedule";
import { optionalJsonObject } from "#src/backend/persistence/sqlite/executions/rows";

type SqliteInboxRow = typeof workflowEventInbox.$inferSelect;

/** An inbox row read back from SQLite's text and epoch columns. */
function sqliteInboxEvent(row: SqliteInboxRow) {
  const data = optionalJsonObject(row.data, "inbox data");
  if (data === null) throw new Error("Invalid SQLite inbox data");
  return inboxEventOf({
    ...row,
    data,
    receivedAt: new Date(row.receivedAt),
    settledAt: row.settledAt === null ? null : new Date(row.settledAt),
  });
}

/** Gives one inbox row its `delivery` schedule row, `queued` and due at `wakeAt`. */
function insertDeliverySchedule(
  database: SqliteExecutor,
  input: { inboxId: string; wakeAt: Date }
) {
  const scheduleId = generateId();
  return database
    .insert(workflowExecutionSchedule)
    .values({
      id: scheduleId,
      kind: "delivery",
      inboxId: input.inboxId,
      state: "queued",
      wakeAt: input.wakeAt.getTime(),
    })
    .pipe(Effect.as(scheduleId));
}

export function makeSqliteInboxMethods(
  store: SqliteDatabase
): InboxRepoMethods {
  const settle = (
    fence: DeliveryFence,
    settled: { status: "delivered" | "failed"; error: string | null; now: Date }
  ) =>
    writeFenced(store, fence, (database) =>
      Effect.gen(function* () {
        yield* database
          .update(workflowEventInbox)
          .set({
            status: settled.status,
            error: settled.error,
            settledAt: settled.now.getTime(),
          })
          .where(
            and(
              eq(workflowEventInbox.id, fence.inboxId),
              eq(workflowEventInbox.status, "pending")
            )
          );
        // The memo rows go with the schedule row by cascade.
        yield* database
          .delete(workflowExecutionSchedule)
          .where(eq(workflowExecutionSchedule.id, fence.scheduleId));
      })
    );

  return {
    insertInboxEvent: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const inboxId = generateId();
          // The inbox id is minted here, so the only unique index a new row
          // can meet is the idempotency key's.
          const inserted = yield* database
            .insert(workflowEventInbox)
            .values({
              id: inboxId,
              name: input.name,
              data: JSON.stringify(input.data),
              connectionId: input.connectionId,
              idempotencyKey: input.idempotencyKey,
              receivedAt: input.now.getTime(),
              status: "pending",
            })
            .onConflictDoNothing()
            .returning({ id: workflowEventInbox.id });
          if (inserted.length > 0) {
            const scheduleId = yield* insertDeliverySchedule(database, {
              inboxId,
              wakeAt: input.now,
            });
            return {
              duplicate: false,
              inboxId,
              scheduleId,
            } satisfies InboxInsert;
          }

          const { idempotencyKey } = input;
          const existing =
            idempotencyKey === null
              ? undefined
              : yield* database
                  .select({ id: workflowEventInbox.id })
                  .from(workflowEventInbox)
                  .where(
                    holdsInboxKey(workflowEventInbox, {
                      ...input,
                      idempotencyKey,
                    })
                  )
                  .get();
          if (!existing) {
            throw new Error(
              "An inbox insert conflicted, and no row holds its idempotency key"
            );
          }
          return {
            duplicate: true,
            inboxId: existing.id,
          } satisfies InboxInsert;
        })
      ),

    scheduleUnscheduledInbox: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const awaiting = yield* database
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
            .limit(input.limit);
          return yield* Effect.forEach(awaiting, (row) =>
            insertDeliverySchedule(database, {
              inboxId: row.id,
              wakeAt: input.now,
            }).pipe(
              Effect.map((scheduleId) => ({ scheduleId, inboxId: row.id }))
            )
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
      store.write((database) =>
        database
          .delete(workflowEventInbox)
          .where(
            inArray(
              workflowEventInbox.id,
              database
                .select({ id: workflowEventInbox.id })
                .from(workflowEventInbox)
                .where(
                  sweepableInbox(workflowEventInbox, input.olderThan.getTime())
                )
                .orderBy(asc(workflowEventInbox.receivedAt))
                .limit(input.limit)
            )
          )
          .returning({ id: workflowEventInbox.id })
          .pipe(Effect.map((swept) => swept.length))
      ),

    findInboxEvent: (inboxId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowEventInbox)
          .where(eq(workflowEventInbox.id, inboxId))
          .get()
          .pipe(Effect.map((row) => (row ? sqliteInboxEvent(row) : null)))
      ),
  };
}
