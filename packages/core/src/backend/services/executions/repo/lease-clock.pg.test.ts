/**
 * PostgreSQL keeps leases on the database's clock, so a worker whose own
 * clock runs ahead of the database's cannot take a lease that is still live.
 * A worker's clock is faked through `Date`, which is what its default `now`
 * and the offset measurement both read.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  claimRun,
  LEASE_MS,
  scheduledRun,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import {
  POSTGRES_TEST_URL_VARIABLE,
  postgresTestUrl,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

const shared = sharedPostgresTestDatabase();
const skip = postgresTestUrl()
  ? undefined
  : `set ${POSTGRES_TEST_URL_VARIABLE} to run it: docker compose up -d`;

/** Claims every due run for `workerId` on the worker's own clock. */
function claimAll(workerId: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    return yield* executions.claimDue({
      lanes: [{ kind: "run", limit: 10 }],
      workerId,
      leaseMs: LEASE_MS,
      now: new Date(),
    });
  });
}

(skip === undefined ? describe : describe.skip)(
  `PostgreSQL lease clock${skip === undefined ? "" : ` (${skip})`}`,
  () => {
    const { openDatabase } = usePersistenceRegistry(
      shared.createDatabase,
      shared.teardown
    );
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps a live lease from a worker whose clock runs ahead of the database's by more than the lease", async () => {
      const database = await openDatabase();
      const holder = await seeded(await database.open());
      const executionId = await holder.run(
        Effect.gen(function* () {
          const run = yield* scheduledRun(new Date());
          yield* claimRun(run, new Date());
          return run;
        })
      );

      const realNow = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(realNow + 2 * LEASE_MS);
      const ahead = await database.open();
      const claimed = await ahead.run(claimAll("worker_ahead"));
      vi.useRealTimers();

      expect(claimed).toEqual([]);
      const schedule = await holder.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.findSchedule({ executionId })
        )
      );
      expect(schedule).toMatchObject({ state: "leased", workerId: "worker_1" });
    });

    it("still sweeps a lease that expired on the database's clock for a worker whose clock runs behind it", async () => {
      const database = await openDatabase();
      const holder = await seeded(await database.open());
      const executionId = await holder.run(
        Effect.gen(function* () {
          // Leased two leases ago, so its lease has run out on every clock
          // but the one behind.
          const run = yield* scheduledRun(new Date(Date.now() - 3 * LEASE_MS));
          yield* claimRun(run, new Date(Date.now() - 2 * LEASE_MS));
          return run;
        })
      );

      const realNow = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(realNow - 2 * LEASE_MS);
      const behind = await database.open();
      const claimed = await behind.run(claimAll("worker_behind"));
      vi.useRealTimers();

      expect(claimed).toMatchObject([{ kind: "run", executionId }]);
    });
  }
);
