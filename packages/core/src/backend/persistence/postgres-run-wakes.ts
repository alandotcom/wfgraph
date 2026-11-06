/**
 * The PostgreSQL `RunWakeBroadcast`: `NOTIFY` and `LISTEN` on one channel. A
 * transaction that issued `NOTIFY` serializes on a database-wide lock at commit,
 * so producers' writes commit without it, and one notification per flush
 * interval in a transaction of its own carries every run made due in it.
 */

import type { Sql } from "postgres";
import { generateId } from "@wfgraph/shared/utils/id";
import { getAppLogger } from "#src/backend/lib/logger";
import type { RunWakeBroadcast } from "#src/backend/persistence/types";

/** How long a loop on PostgreSQL sleeps between claims when nothing wakes it. */
export const POSTGRES_POLL_MS = 1_000;

/**
 * How many passes a loop on PostgreSQL runs at once. A pass spends most of its
 * time waiting on the database, so several overlap on one event loop.
 */
export const POSTGRES_WORKER_CONCURRENCY = 10;

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
  /** Sends the notification still waiting, then stops the flush timer. */
  readonly close: () => Promise<void>;
};

/**
 * The broadcast for one app's pool. `client` sends each notification on a
 * pooled connection, and the first `listen` opens the dedicated connection
 * postgres.js keeps for listening, which `client.end()` closes.
 */
export function createPostgresRunWakes(input: {
  client: Sql;
  schema: string;
}): PostgresRunWakes {
  const { client, schema } = input;
  // Names this app's notifications, so its own listener skips them: its
  // producers already woke its loop directly.
  const sender = generateId();
  const payload = `${schema} ${sender}`;
  // The runs made due since the last flush, by Execution id.
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    timer = undefined;
    if (pending.size === 0) return;
    const runs = pending.size;
    pending.clear();
    try {
      await client.notify(CHANNEL, payload);
    } catch (error) {
      logger.warn(
        "Could not notify other processes of due runs; their poll finds them",
        { wake: { runs }, error }
      );
    }
  };

  return {
    announce: (executionId) => {
      pending.add(executionId);
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
      if (timer !== undefined) clearTimeout(timer);
      await flush();
    },
  };
}
