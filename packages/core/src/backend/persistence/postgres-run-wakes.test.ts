/**
 * The PostgreSQL broadcast's batching and its close, over a client stand-in
 * whose `notify` the case answers by hand, so a flush can be held in flight.
 */

import { describe, expect, it } from "vitest";
import { createPostgresRunWakes } from "#src/backend/persistence/postgres-run-wakes";

function heldClient() {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  return {
    sent,
    /** Answers every notification still waiting for the database. */
    answer: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    client: {
      notify: (_channel: string, payload: string) => {
        sent.push(payload);
        return new Promise<void>((resolve) => {
          pending.push(resolve);
        });
      },
      listen: () => Promise.resolve({ unlisten: () => Promise.resolve() }),
    },
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("createPostgresRunWakes", () => {
  it("sends one notification for the wakes noted within a flush", async () => {
    const held = heldClient();
    const wakes = createPostgresRunWakes({ client: held.client, schema: "s" });
    wakes.announce();
    wakes.announce();
    wakes.announce();
    await sleep(80);
    held.answer();
    await wakes.close();

    expect(held.sent).toHaveLength(1);
  });

  it("waits for a notification in flight before close resolves", async () => {
    const held = heldClient();
    const wakes = createPostgresRunWakes({ client: held.client, schema: "s" });
    wakes.announce();
    await sleep(80);
    expect(held.sent).toHaveLength(1);

    let closed = false;
    const closing = wakes.close().then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closed).toBe(false);

    held.answer();
    await closing;
    expect(closed).toBe(true);
  });

  it("sends a wake noted before close, and nothing noted after it", async () => {
    const held = heldClient();
    const wakes = createPostgresRunWakes({ client: held.client, schema: "s" });
    wakes.announce();
    const closing = wakes.close();
    await sleep(0);
    held.answer();
    await closing;
    expect(held.sent).toHaveLength(1);

    wakes.announce();
    await sleep(80);
    expect(held.sent).toHaveLength(1);
  });
});
