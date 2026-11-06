import { describe, expect, it } from "vitest";
import {
  createQueueWake,
  type WfGraphWakeMessage,
} from "#src/backend/executor/queue-wake";
import { sleep, waitUntil } from "#src/backend/executor/testing/waiting";

/** A Queue whose sends settle one at a time when the case releases them. */
function heldQueue() {
  const sent: WfGraphWakeMessage[] = [];
  const pending: Array<() => void> = [];
  /** Settles the `count`th send once it has started. */
  const release = async (count: number) => {
    await waitUntil(() => sent.length >= count, `Send ${count} never started`);
    pending.shift()?.();
  };
  return {
    sent,
    release,
    queue: {
      send: (message: WfGraphWakeMessage) => {
        sent.push(message);
        return new Promise<void>((resolve) => {
          pending.push(resolve);
        });
      },
    },
  };
}

describe("createQueueWake", () => {
  it("sends one message per announcement made while no send is in flight", async () => {
    const held = heldQueue();
    const wake = createQueueWake(held.queue);

    wake.announce();
    await held.release(1);
    await wake.settled();
    wake.announce();
    await held.release(2);
    await wake.settled();

    expect(held.sent).toEqual([
      { kind: "wfgraph.wake" },
      { kind: "wfgraph.wake" },
    ]);
  });

  it("collapses the announcements made during a send into one more send after it", async () => {
    const held = heldQueue();
    const wake = createQueueWake(held.queue);

    wake.announce();
    wake.announce();
    wake.announce();
    const settled = wake.settled();
    await held.release(1);
    await held.release(2);
    await settled;
    // Nothing is left to send once the follow-up has settled.
    await sleep(20);

    expect(held.sent).toHaveLength(2);
  });

  // A lost wake costs at most one Cron Trigger interval, so a failed send
  // must not fail the request or tick that announced it.
  it("settles without rejecting when the Queue refuses a send", async () => {
    let attempts = 0;
    const wake = createQueueWake({
      send: () => {
        attempts += 1;
        return Promise.reject(new Error("Too Many Requests"));
      },
    });

    wake.announce();
    await expect(wake.settled()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });

  it("settles at once when nothing was announced", async () => {
    const wake = createQueueWake({
      send: () => Promise.reject(new Error("never sent")),
    });

    await expect(wake.settled()).resolves.toBeUndefined();
  });
});
