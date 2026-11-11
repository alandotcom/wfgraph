/**
 * The event inbox's decisions, made once for both backends: which inbox rows
 * the poll gives a delivery schedule row, which row holds an arrival's
 * idempotency key and what a resend does with it, which row a settling write
 * takes, which rows the retention sweep deletes, and how a row reads back as
 * an `InboxEvent`. Each backend runs the statements inside its own
 * transaction, as `release-policy.ts` describes for the run's decisions.
 */

import { type Column, type SQL, type Table, sql } from "drizzle-orm";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type {
  InboxEvent,
  NewInboxEvent,
} from "#src/backend/services/executions/repo/contracts";
import {
  type BoundInstant,
  instantOf,
} from "#src/backend/services/executions/repo/release-policy";

/** The inbox row columns the decisions read. */
type InboxColumns = {
  id: Column;
  name: Column;
  connectionId: Column;
  idempotencyKey: Column;
  receivedAt: Column;
  status: Column;
};

/**
 * Whether the poll gives this inbox row a delivery schedule row: it is
 * `pending` and no schedule row names it. A row inserted through the SQL
 * contract starts this way. A row a send inserted has its schedule row from
 * the same transaction, and a settled row is never scheduled again.
 */
export function awaitsSchedule(
  inbox: Pick<InboxColumns, "id" | "status">,
  schedule: { table: Table; inboxId: Column }
): SQL {
  return sql`(${inbox.status} = 'pending' and not exists (select 1 from ${schedule.table} where ${schedule.inboxId} = ${inbox.id}))`;
}

/**
 * Whether this inbox row holds the idempotency key of `arrival`: the same
 * Event name, the same Connection, and the same key. A missing Connection
 * compares as the empty string, as the unique index on the key does.
 */
export function holdsInboxKey(
  inbox: Pick<InboxColumns, "name" | "connectionId" | "idempotencyKey">,
  arrival: Pick<NewInboxEvent, "name" | "connectionId"> & {
    idempotencyKey: string;
  }
): SQL {
  return sql`(${inbox.name} = ${arrival.name} and coalesce(${inbox.connectionId}, '') = ${arrival.connectionId ?? ""} and ${inbox.idempotencyKey} = ${arrival.idempotencyKey})`;
}

/**
 * What an arrival does with the inbox row that already holds its idempotency
 * key, by that row's status. A `failed` row is reopened and delivered again,
 * so a webhook a vendor resends after a delivery failed for good, during an
 * outage for example, still reaches its workflows. A `pending` or `delivered`
 * row answers the arrival as a duplicate.
 */
export function resendOnHeldKey(status: string): "reopen" | "duplicate" {
  return status === "failed" ? "reopen" : "duplicate";
}

/**
 * Whether a settling write takes this inbox row: it is the delivery's own row
 * and still `pending`. A row that settled already stays as it settled.
 */
export function settleableInbox(
  inbox: Pick<InboxColumns, "id" | "status">,
  inboxId: string
): SQL {
  return sql`(${inbox.id} = ${inboxId} and ${inbox.status} = 'pending')`;
}

/**
 * Whether the retention sweep deletes this inbox row: its delivery settled,
 * as `delivered` or `failed`, and it arrived before `olderThan`. A `pending`
 * row is never swept, since its arrival has not been delivered yet.
 *
 * "Settled" is written as `status <> 'pending'`, the predicate of the settled
 * index on both backends, because SQLite uses a partial index only for a
 * query whose terms state its predicate. The status check admits no third
 * settled status for the two forms to differ on.
 */
export function sweepableInbox(
  inbox: Pick<InboxColumns, "status" | "receivedAt">,
  olderThan: BoundInstant
): SQL {
  return sql`(${inbox.status} <> 'pending' and ${inbox.receivedAt} < ${instantOf(inbox.receivedAt, olderThan)})`;
}

/** An inbox row's columns, as both backends read them back. */
export type InboxEventColumns = {
  id: string;
  name: string;
  data: JsonObject;
  connectionId: string | null;
  idempotencyKey: string | null;
  receivedAt: Date;
  status: string;
  error: string | null;
  settledAt: Date | null;
};

/** An inbox row's columns as an `InboxEvent`. The table's checks keep them consistent. */
export function inboxEventOf(row: InboxEventColumns): InboxEvent {
  const arrival = {
    id: row.id,
    name: row.name,
    data: row.data,
    connectionId: row.connectionId,
    idempotencyKey: row.idempotencyKey,
    receivedAt: row.receivedAt,
  };
  const { status, settledAt, error } = row;
  if (status === "pending") return { ...arrival, status };
  if (status === "delivered" && settledAt !== null) {
    return { ...arrival, status, settledAt };
  }
  if (status === "failed" && settledAt !== null && error !== null) {
    return { ...arrival, status, settledAt, error };
  }
  throw new Error(`An inbox row holds the invalid status ${status}`);
}
