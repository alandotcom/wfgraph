/**
 * The runner `createWfGraphApp` starts on PostgreSQL: the loop listens for the
 * runs other processes make due, and dispose stops listening after the loop
 * has drained and before the database closes.
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createWfGraphApp } from "#src/app";
import { trustWfGraphUpstream } from "#src/index";
import { migrateWfGraphDatabase } from "#src/migrate";
import * as workerLoopModule from "#src/backend/executor/worker-loop";
import { wfPostgres } from "#src/backend/persistence/postgres";
import {
  describePostgres,
  mintTestSchemaName,
  requirePostgresTestUrl,
  withAdminClient,
} from "#src/backend/persistence/postgres-test-database";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";

const ENCRYPTION = { key: "b".repeat(64) };

describePostgres("createWfGraphApp runner on PostgreSQL", () => {
  let url: string;
  let schema: string;

  beforeAll(async () => {
    url = requirePostgresTestUrl();
    schema = mintTestSchemaName();
    await migrateWfGraphDatabase({ url, schema });
  });

  afterAll(async () => {
    await withAdminClient(async (client) => {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The PostgreSQL backend with its listener and its close observed: each
   * step lands in `events`, and `heard` counts the notifications the app's
   * listener heard.
   */
  function observedPostgres(events: string[]) {
    let heard = 0;
    const listening = Promise.withResolvers<void>();
    const persistence: WfGraphPersistence = {
      open: async (cipher) => {
        const instance = await wfPostgres({ url, schema }).open(cipher);
        const { wakes } = instance;
        if (wakes.kind !== "notify") throw new Error("Expected notify wakes");
        return {
          ...instance,
          wakes: {
            ...wakes,
            broadcast: {
              ...wakes.broadcast,
              listen: async (onWake) => {
                const listener = await wakes.broadcast.listen(() => {
                  heard += 1;
                  onWake();
                });
                events.push("listening");
                listening.resolve();
                return {
                  stop: async () => {
                    events.push("listener stopped");
                    await listener.stop();
                  },
                };
              },
            },
          },
          close: async () => {
            events.push("persistence closed");
            await instance.close();
          },
        };
      },
    };
    return { persistence, listening: listening.promise, heard: () => heard };
  }

  it("listens for other processes' wakes and stops after the loop drains", async () => {
    const events: string[] = [];
    const runWorkerLoop = workerLoopModule.runWorkerLoop;
    vi.spyOn(workerLoopModule, "runWorkerLoop").mockImplementation((options) =>
      runWorkerLoop(options).pipe(
        Effect.ensuring(Effect.sync(() => events.push("loop ended")))
      )
    );
    const observed = observedPostgres(events);

    const app = await createWfGraphApp({
      auth: trustWfGraphUpstream(),
      persistence: observed.persistence,
      encryption: ENCRYPTION,
      inngest: { id: "wfgraph-app-pg-test", isDev: true },
    });
    await observed.listening;

    // Another process on the same schema announces a run it made due.
    const other = await wfPostgres({ url, schema }).open(
      createIntegrationCipher(ENCRYPTION)
    );
    try {
      if (other.wakes.kind !== "notify") throw new Error("Expected notify");
      other.wakes.broadcast.announce("exec_elsewhere");
      await vi.waitFor(() => expect(observed.heard()).toBe(1), {
        timeout: 2_000,
      });
    } finally {
      await other.close();
    }

    await app.dispose();
    expect(events).toEqual([
      "listening",
      "loop ended",
      "listener stopped",
      "persistence closed",
    ]);
  });
});
