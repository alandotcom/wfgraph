/**
 * The arrival a resume claim records on a wait row: why the row was claimed,
 * and what arrived. The repositories write it and the engine reads it back,
 * so the shared package is where the two meet.
 */

import { Schema } from "effect";
import type { JsonObject } from "#src/types/json";

/**
 * Why a wait row was claimed, as the `signalType` key spells it.
 *
 * `wait-resume` is an Event arrival or a manual resume from the Runs view.
 * `lifecycle-cancel` is a Cancel Event claiming the run. `lifecycle-exit` is an
 * Entity Eligibility Exit claimed by another branch of the same run.
 * `version-migrate` tells a parked Wait to prepare itself again against the
 * Workflow Version the execution row now names.
 */
export const WAIT_SIGNAL_TYPES = [
  "wait-resume",
  "lifecycle-cancel",
  "lifecycle-exit",
  "version-migrate",
] as const;

export type WaitSignalType = (typeof WAIT_SIGNAL_TYPES)[number];

/**
 * The wait row metadata key a resume claim writes its arrival under, and the key
 * the engine reads back when a re-park finds the row has left `waiting`.
 */
export const WAIT_ARRIVAL_METADATA_KEY = "arrival";

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

/** What a resume claim records about the signal that claimed a wait row. */
export type WaitArrival = {
  signalType: WaitSignalType;
  /** The Event that arrived, and null for a resume that named none. */
  eventName: string | null;
  payload: JsonObject;
  /** The Inngest delivery id, which identifies a retried Event arrival. */
  deliveryId?: string | undefined;
};

const waitSignalTypeSchema = Schema.Literals([...WAIT_SIGNAL_TYPES]);

/** Whether an arbitrary value is one of the `WAIT_SIGNAL_TYPES`. */
export const isWaitSignalType: (value: unknown) => value is WaitSignalType =
  Schema.is(waitSignalTypeSchema);
