/**
 * The arrival-order rule between a Cancel Event and a start on PostgreSQL, as
 * `cancel-order-policy.ts` decides it. Every function runs inside the caller's
 * transaction. A Cancel claim and an Event start each take the Entity's
 * advisory lock before they read, the Cancel exclusive and the start shared,
 * so whichever commits second sees the other's write.
 */

import { asc, eq, sql } from "drizzle-orm";
import {
  workflowCancelDecisions,
  workflowEventInbox,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import type { WfGraphTransaction } from "#src/backend/lib/db/index";
import { recordAuditEventsWrite } from "#src/backend/services/executions/repo/audit";
import {
  cancelReceivedNoEarlier,
  cancelScopeLockKeys,
} from "#src/backend/services/executions/repo/cancel-order-policy";
import type {
  NewExecution,
  WorkflowExecution,
} from "#src/backend/services/executions/repo/contracts";
import { cancelRequestedEntries } from "#src/backend/services/executions/repo/release-policy";

/** The strength a transaction takes an Entity's advisory lock with. */
type LockMode = "exclusive" | "shared";

function lockFunction(mode: LockMode, attempt: "wait" | "try"): string {
  const prefix =
    attempt === "try" ? "pg_try_advisory_xact_lock" : "pg_advisory_xact_lock";
  return mode === "shared" ? `${prefix}_shared` : prefix;
}

/**
 * Takes the transaction's advisory lock on each key, in the order given,
 * which `cancelScopeLockKeys` sorts. A Cancel claim takes them exclusive and
 * an Event start shared, so starts of one Entity never wait on each other and
 * a Cancel waits on every start in flight. The locks are released when the
 * transaction ends.
 */
export async function lockCancelScope(
  tx: WfGraphTransaction,
  keys: readonly string[],
  mode: LockMode = "exclusive"
): Promise<void> {
  for (const key of keys) {
    // eslint-disable-next-line eslint/no-await-in-loop -- the keys are taken in order, so two holders never wait on each other
    await tx.execute(
      sql`select ${sql.raw(lockFunction(mode, "wait"))}(hashtextextended(${key}, 0))`
    );
  }
}

/**
 * Takes the shared lock an Event start holds before it reads anything, on its
 * Entity in its own identity form. A start no Event delivered takes none,
 * since no Cancel decision is looked up for it.
 *
 * A SERIALIZABLE transaction reads from the snapshot its first statement
 * took, so the lock must be that statement, and a lock it had to wait for
 * would leave it reading from before the holder committed. In that isolation
 * the lock is tried, and a lock a Cancel claim holds is waited for and then
 * answered with a serialization failure, which `serializableTransaction`
 * retries with a fresh snapshot.
 */
export async function lockEventStart(
  tx: WfGraphTransaction,
  execution: Pick<
    NewExecution,
    "workflowId" | "deliveryId" | "entityType" | "entityId" | "entityValue"
  >,
  isolation: "read committed" | "serializable"
): Promise<void> {
  if (execution.deliveryId === undefined) return;
  const keys = cancelScopeLockKeys(execution.workflowId, execution, "own");
  if (isolation === "read committed") {
    await lockCancelScope(tx, keys, "shared");
    return;
  }
  for (const key of keys) {
    // eslint-disable-next-line eslint/no-await-in-loop -- the keys are taken in order
    const [taken] = await tx.execute<{ locked: boolean }>(
      sql`select ${sql.raw(lockFunction("shared", "try"))}(hashtextextended(${key}, 0)) as locked`
    );
    if (taken?.locked) continue;
    // eslint-disable-next-line eslint/no-await-in-loop -- waits once, then the attempt ends
    await lockCancelScope(tx, [key], "shared");
    // eslint-disable-next-line eslint/no-await-in-loop -- the attempt ends here
    await tx.execute(
      sql.raw(
        `do $$ begin raise exception 'An Event start waited for its Entity''s lock' using errcode = '40001'; end $$`
      )
    );
  }
}

/** When the inbox row `inboxId` was received, or null when there is none. */
export async function receivedAtOf(
  tx: WfGraphTransaction,
  inboxId: string
): Promise<Date | null> {
  const [arrival] = await tx
    .select({ receivedAt: workflowEventInbox.receivedAt })
    .from(workflowEventInbox)
    .where(eq(workflowEventInbox.id, inboxId));
  return arrival?.receivedAt ?? null;
}

/**
 * Claims the run an Event start just opened for the earliest Cancel decision
 * of its workflow and Entity received no earlier than its start Event, when
 * one was recorded: the Cancel was received after the start, so it would have
 * claimed the run had the two been delivered in arrival order. The claim is
 * the one `requestCancelForEntity` writes, with its timeline entry; the run
 * opened with no parks, so it resolves none.
 */
export async function claimForCancelDeliveredFirst(
  tx: WfGraphTransaction,
  run: WorkflowExecution,
  now: Date
): Promise<void> {
  if (run.deliveryId === null || run.deliveryId === undefined) return;
  const startReceivedAt = await receivedAtOf(tx, run.deliveryId);
  if (startReceivedAt === null) return;
  const later = cancelReceivedNoEarlier(workflowCancelDecisions, {
    workflowId: run.workflowId,
    run,
    startReceivedAt,
  });
  if (later === undefined) return;
  const [decision] = await tx
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
  await tx
    .update(workflowExecutions)
    .set({
      terminationKind: "cancel",
      terminationRequestedAt: now,
      cancelEventName: decision.eventName,
      cancelPayload: decision.payload,
      cancelDeliveryId: decision.deliveryId,
    })
    .where(eq(workflowExecutions.id, run.id));
  await recordAuditEventsWrite(
    cancelRequestedEntries({
      workflowId: run.workflowId,
      eventName: decision.eventName,
      flagged: [run.id],
      resolved: [],
    })
  )(tx);
}
