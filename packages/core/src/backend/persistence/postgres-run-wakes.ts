/**
 * The PostgreSQL `RunWakeBroadcast`: `NOTIFY` and `LISTEN` on one channel. A
 * transaction that issued `NOTIFY` serializes on a database-wide lock at commit,
 * so producers' writes commit without it, and one notification per flush
 * interval in a transaction of its own carries every row made due in it.
 */

import { generateId } from "@wfgraph/shared/utils/id";
import { getAppLogger } from "#src/backend/lib/logger";
import type { RunWakeBroadcast } from "#src/backend/persistence/types";

/** How long a noted wake waits before the notification that carries it. */
const FLUSH_MS = 50;

/**
 * The one channel every Workflow Graph on the database notifies on. Each
 * payload names its schema, so two installs in different schemas of one
 * database do not wake each other's loops.
 */
const CHANNEL = "wfgraph_run_wake";

const logger = getAppLogger("executor");

export type PostgresRunWakes = RunWakeBroadcast & {
  /**
   * Sends the notification still waiting, or waits for the one being sent,
   * and stops the flush timer. `announce` does nothing once this is called.
   */
  readonly close: () => Promise<void>;
};

/** The two calls of a postgres.js client the broadcast makes. */
type NotifyClient = {
  notify: (channel: string, payload: string) => PromiseLike<unknown>;
  listen: (
    channel: string,
    onNotify: (payload: string) => void
  ) => Promise<{ unlisten: () => Promise<void> }>;
};

/**
 * The broadcast for one app's pool. `client` sends each notification on a
 * pooled connection, and the first `listen` opens the dedicated connection
 * postgres.js keeps for listening, which `client.end()` closes.
 */
export function createPostgresRunWakes(input: {
  client: NotifyClient;
  schema: string;
}): PostgresRunWakes {
  const { client, schema } = input;
  // Names this app's notifications, so its own listener skips them: its
  // producers already woke its loop directly.
  const sender = generateId();
  const payload = `${schema} ${sender}`;
  // How many writes made rows due since the last flush.
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The notification being sent, which `close` waits for.
  let sending: Promise<void> | undefined;
  // Set by `close`, after which the pool is about to end and nothing is sent.
  let closed = false;

  const send = async (writes: number) => {
    try {
      await client.notify(CHANNEL, payload);
    } catch (error) {
      logger.warn(
        "Could not notify other processes of due rows; their poll finds them",
        { wake: { writes }, error }
      );
    }
  };

  const flush = async () => {
    timer = undefined;
    if (pending === 0) return;
    const writes = pending;
    pending = 0;
    const sent = send(writes);
    sending = sent;
    await sent;
    if (sending === sent) sending = undefined;
  };

  return {
    announce: () => {
      if (closed) return;
      pending += 1;
      if (timer !== undefined) return;
      timer = setTimeout(() => void flush(), FLUSH_MS);
      // A wake waiting to be sent never keeps the process alive.
      timer.unref();
    },

    listen: async (onWake) => {
      const listening = await client.listen(CHANNEL, (received) => {
        const [fromSchema, fromSender] = received.split(" ");
        if (fromSchema === schema && fromSender !== sender) onWake();
      });
      return { stop: () => listening.unlisten() };
    },

    close: async () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      await sending;
      await flush();
    },
  };
}
