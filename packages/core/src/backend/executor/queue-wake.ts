/**
 * The run wake a Cloudflare Worker sends through a Queue. A producer's
 * announcement sends one message at once, and the announcements made while
 * that send is in flight collapse into one more send after it, so one Worker
 * invocation sends at most one message per burst of writes. A send that fails
 * is logged and lost; the Cron Trigger's next tick finds the rows it named.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import type { RunWakeSink } from "#src/backend/services/executions/wakes";

/** The body of every wake message. A wake names no row: a tick claims every due one. */
export type WfGraphWakeMessage = { readonly kind: "wfgraph.wake" };

/**
 * The part of a Cloudflare Queue producer binding Workflow Graph uses. A
 * binding declared as `Queue` or `Queue<WfGraphWakeMessage>` satisfies it.
 */
export type WfGraphWakeQueue = {
  readonly send: (message: WfGraphWakeMessage) => Promise<unknown>;
};

export type QueueWake = RunWakeSink & {
  /** Settles once every send this sink started has settled. Never rejects. */
  readonly settled: () => Promise<void>;
};

const WAKE_MESSAGE: WfGraphWakeMessage = { kind: "wfgraph.wake" };

const logger = getAppLogger("executor");

export function createQueueWake(queue: WfGraphWakeQueue): QueueWake {
  // The send in flight, which also covers the one send queued behind it.
  let sending: Promise<void> | undefined;
  let announcedWhileSending = false;

  const send = (): Promise<void> =>
    Promise.resolve()
      .then(() => queue.send(WAKE_MESSAGE))
      .then(
        () => undefined,
        (error: unknown) => {
          logger.warn(
            "Could not send a run wake to the Queue; the Cron Trigger's next tick finds the runs it would have woken",
            { error }
          );
        }
      )
      .then(() => {
        if (!announcedWhileSending) {
          sending = undefined;
          return undefined;
        }
        announcedWhileSending = false;
        return send();
      });

  const settled = async (): Promise<void> => {
    const current = sending;
    if (current === undefined) return;
    await current;
    // An announcement made after that send settled started a new one.
    await settled();
  };

  return {
    announce: () => {
      if (sending === undefined) {
        sending = send();
      } else {
        announcedWhileSending = true;
      }
    },
    settled,
  };
}
