/**
 * What a resume brings to a parked Wait, and the wait row metadata key the
 * engine and the migration preflight both read. The repositories write a
 * resume into the wait row's `wake` column, and the engine reads it back, so
 * the shared package is where the two meet.
 */

import type { JsonObject } from "#src/types/json";

/**
 * The wait row metadata key holding the instant the first park resolved against,
 * as an ISO string.
 *
 * Every later attempt of the same Wait measures its target from that instant, so
 * a Migration changes a Wait's target without restarting its clock. The
 * migration preflight reads the same key, which is how its elapsed-timeout check
 * measures from the instant the engine measures from.
 */
export const WAIT_ANCHOR_METADATA_KEY = "anchorAt";

/** What an Event arrival or a manual resume brings to the park it claims. */
export type WaitArrival = {
  /** The Event that arrived, and null for a resume that named none. */
  eventName: string | null;
  payload: JsonObject;
  /**
   * The delivery that carried an Event, which identifies a retry of that same
   * delivery. A manual resume has none.
   */
  deliveryId?: string | undefined;
};
