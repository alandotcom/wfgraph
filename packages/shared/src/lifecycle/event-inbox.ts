/**
 * The event inbox's vocabulary: where one arrival's delivery stands, as
 * `workflow_event_inbox.status` stores it. It lives in shared so both Drizzle
 * schemas can build their check constraints without importing through `#src/`.
 */

/**
 * Where an inbox row's delivery stands. `pending` has not settled and keeps a
 * delivery schedule row, which the poll writes for a row inserted without one.
 * `delivered` ran its delivery to the end. `failed` spent its delivery's retries
 * and records the error. A settled row has no schedule row and is never
 * scheduled again; the retention sweep deletes it once it is old enough.
 */
export const EVENT_INBOX_STATUSES = ["pending", "delivered", "failed"] as const;
export type EventInboxStatus = (typeof EVENT_INBOX_STATUSES)[number];
