/**
 * `events` on what `createWfGraphApp` and `createWfGraphRunner` answer: a
 * host's in-process send into the event inbox. `send` resolves once the inbox
 * row has committed, and rejects with `WfGraphEventRefused` for a send the
 * caller can correct, or with an `Error` whose `cause` holds the storage
 * failure. Neither message quotes what the caller sent.
 */

import { Effect } from "effect";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { sendEvent } from "#src/backend/services/executions/send-event";
import type { JsonObject } from "@wfgraph/shared/types/json";

/** One Event as a host raises it. */
export type WfGraphEventInput = {
  /** The name of an Event in the app's catalog. */
  name: string;
  /** The payload, checked against that Event's schema. */
  data: JsonObject;
  /**
   * The idempotency key. A second send with the same name and id is answered
   * with the first send's inbox row while that row exists, and opens nothing.
   */
  id?: string | undefined;
};

/** What a send answers. */
export type WfGraphEventReceipt = {
  /** The inbox row that holds the arrival. */
  id: string;
  /** Whether an earlier send with the same `id` already held that row. */
  duplicate: boolean;
};

export type WfGraphEvents = {
  /**
   * Validates the Event against the catalog and records it in the event
   * inbox, where the worker loop delivers it to every workflow it starts,
   * cancels or wakes.
   */
  send: (event: WfGraphEventInput) => Promise<WfGraphEventReceipt>;
};

/**
 * A send the caller can correct: a name no catalog Event has, a payload the
 * Event's schema refuses, or a malformed argument. The message names fields
 * and rules.
 */
export class WfGraphEventRefused extends Error {
  override readonly name = "WfGraphEventRefused";
}

export function createHostEvents(runtime: WfGraphRuntime): WfGraphEvents {
  return {
    send: async (event) => {
      const outcome = await runtime.runPromise(
        sendEvent(event).pipe(
          Effect.match({
            onSuccess: (receipt) => ({ ok: true as const, receipt }),
            onFailure: (failure) => ({ ok: false as const, failure }),
          })
        )
      );
      if (outcome.ok) return outcome.receipt;
      const { failure } = outcome;
      if (failure._tag === "InvalidInput") {
        throw new WfGraphEventRefused(failure.error);
      }
      throw new Error(failure.error, { cause: failure.cause });
    },
  };
}
