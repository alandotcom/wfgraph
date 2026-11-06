/**
 * `events` on what `createWfGraphApp` and `createWfGraphRunner` answer: a
 * host's in-process send into the event inbox. `send` resolves once the inbox
 * row has committed, and rejects only with `WfGraphEventRefused` for a send
 * the caller can correct, or with an `Error` whose `cause` holds the storage
 * failure or the defect, such as a send after the app was disposed. Neither
 * message quotes what the caller sent.
 */

import { Cause, Exit, Option } from "effect";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { sendEvent } from "#src/backend/services/executions/send-event";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { isBlank } from "@wfgraph/shared/types/string";

/** How Events reach this app's event inbox, and how long the inbox keeps them. */
export type WfGraphEventsOptions = {
  /**
   * The shared key that mounts `POST {basePath}/api/events`. A sender
   * presents it as `Authorization: Bearer <key>`, so it holds no
   * whitespace. Absent, the route is not
   * mounted, and `app.events.send` stays the only way in besides webhook
   * intake and a host's own insert. Treat it as a secret, like `encryption.key`.
   */
  key?: string | undefined;
  /**
   * How long a delivered or failed inbox row is kept after it arrived, in
   * milliseconds. Defaults to seven days. This is also the deduplication
   * window: a send whose idempotency key matches a row still kept answers
   * with that row, and once the sweep has deleted the row the same key is a
   * new arrival. Every process that runs a worker loop sweeps with its own
   * window, so a host running loops in more than one process, such as an
   * app beside `createWfGraphRunner`, sets the same window in each. A pending
   * row is never deleted.
   */
  retentionMs?: number | undefined;
};

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

/**
 * Refuses an `events.key` no sender could present: a blank key, or one
 * holding whitespace, which a single Bearer token cannot carry. `caller`
 * names the function the host called.
 */
export function assertValidEventsKey(
  key: string | undefined,
  caller: string
): void {
  if (key === undefined) return;
  if (isBlank(key)) {
    throw new Error(
      `${caller}'s events.key is blank. Pass a secret to mount POST /api/events, or leave the key out to keep that route off.`
    );
  }
  if (/\s/u.test(key)) {
    throw new Error(
      `${caller}'s events.key contains whitespace, which an Authorization: Bearer header cannot carry. Pass a key without spaces, tabs or line breaks.`
    );
  }
}

export function createHostEvents(runtime: WfGraphRuntime): WfGraphEvents {
  return {
    send: async (event) => {
      // An exit rather than a rejected promise, so a defect, such as a send
      // after the app was disposed, is answered as the storage failure it is
      // to the host and never escapes as whatever the runtime threw.
      const exit = await runtime.runPromiseExit(sendEvent(event));
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isSome(failure)) {
        if (failure.value._tag === "InvalidInput") {
          throw new WfGraphEventRefused(failure.value.error);
        }
        throw new Error(failure.value.error, { cause: failure.value.cause });
      }
      throw new Error("Could not send this Event", {
        cause: Cause.squash(exit.cause),
      });
    },
  };
}
