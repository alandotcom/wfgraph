/**
 * The arrival-order rule between a Cancel Event and a start on SQLite, as
 * `cancel-order-policy.ts` decides it and `repo/cancel-order.ts` describes it.
 * Every write runs in one `BEGIN IMMEDIATE` transaction, which holds the one
 * writer, so a Cancel claim and a start never interleave and take no lock.
 */

import { Effect } from "effect";
import { asc, eq } from "drizzle-orm";
import { cancelReceivedNoEarlier } from "#src/backend/services/executions/repo/cancel-order-policy";
import type { WorkflowExecution } from "#src/backend/services/executions/repo";
import { cancelRequestedEntries } from "#src/backend/services/executions/repo/release-policy";
import type { SqliteExecutor } from "#src/backend/persistence/sqlite/database";
import {
  workflowCancelDecisions,
  workflowEventInbox,
  workflowExecutions,
} from "#src/backend/persistence/sqlite/schema";
import { recordAuditEventsWrite } from "#src/backend/persistence/sqlite/executions/audit";

/** When the inbox row `inboxId` was received, in epoch milliseconds, or null. */
export function receivedAtOf(database: SqliteExecutor, inboxId: string) {
  return database
    .select({ receivedAt: workflowEventInbox.receivedAt })
    .from(workflowEventInbox)
    .where(eq(workflowEventInbox.id, inboxId))
    .pipe(Effect.map(([arrival]) => arrival?.receivedAt ?? null));
}

/**
 * Claims the run an Event start just opened for the earliest Cancel decision
 * of its workflow and Entity received no earlier than its start Event, as
 * `claimForCancelDeliveredFirst` in `repo/cancel-order.ts` describes.
 */
export function claimForCancelDeliveredFirst(
  database: SqliteExecutor,
  run: WorkflowExecution,
  now: Date
) {
  return Effect.gen(function* () {
    if (run.deliveryId === null) return;
    const startReceivedAt = yield* receivedAtOf(database, run.deliveryId);
    if (startReceivedAt === null) return;
    const later = cancelReceivedNoEarlier(workflowCancelDecisions, {
      workflowId: run.workflowId,
      run,
      startReceivedAt,
    });
    if (later === undefined) return;
    const [decision] = yield* database
      .select({
        deliveryId: workflowCancelDecisions.deliveryId,
        eventName: workflowCancelDecisions.eventName,
        payload: workflowEventInbox.data,
      })
      .from(workflowCancelDecisions)
      .innerJoin(
        workflowEventInbox,
        eq(workflowEventInbox.id, workflowCancelDecisions.deliveryId)
      )
      .where(later)
      .orderBy(
        asc(workflowCancelDecisions.receivedAt),
        asc(workflowCancelDecisions.deliveryId)
      )
      .limit(1);
    if (decision === undefined || decision.eventName === null) return;
    // The inbox holds the payload as JSON text, which is the encoding of the
    // run's Cancel payload column too.
    yield* database
      .update(workflowExecutions)
      .set({
        terminationKind: "cancel",
        terminationRequestedAt: now.getTime(),
        cancelEventName: decision.eventName,
        cancelPayload: decision.payload,
        cancelDeliveryId: decision.deliveryId,
      })
      .where(eq(workflowExecutions.id, run.id));
    yield* recordAuditEventsWrite(
      cancelRequestedEntries({
        workflowId: run.workflowId,
        eventName: decision.eventName,
        flagged: [run.id],
        resolved: [],
      })
    )(database);
  });
}
