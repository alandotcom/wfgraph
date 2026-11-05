/**
 * The eight replay suites, with every drive under the database executor run
 * through PostgreSQL: each pass is claimed with `claimDue`, replayed by the
 * executor's runtime over the memo rows, woken through `resolvePark`, and
 * released with `releasePass`, all at the harness's virtual clock.
 *
 * The suites are imported rather than copied, so a case holds the same
 * assertions here as it does in memory. Their Inngest-executor cases run here
 * too, unchanged and without a database. A case that opens its own backend
 * keeps it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useDefaultReplayBackend } from "#src/backend/engine/testing/replay-database-executor";
import { openDatabaseReplayBackend } from "#src/backend/executor/testing/database-replay-backend";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

/** The suites, by the file each case is declared in. */
const SUITES = [
  "core-cancel.test.ts",
  "core-cancel-partial-progress.test.ts",
  "core-migration-snapshot.test.ts",
  "core-parallel-wait.test.ts",
  "core-wait-migrate.test.ts",
  "core-wait-split.test.ts",
  "entity-eligibility.test.ts",
  "replay-runtime.test.ts",
] as const;

const TITLE = "replay suites on PostgreSQL";

if (postgresTestUrl()) {
  // The factory is awaited while the file is collected, so the suites it
  // imports register their cases inside this one, under its hooks.
  describe(TITLE, async () => {
    const shared = sharedPostgresTestDatabase();
    const registry = usePersistenceRegistry(
      shared.createDatabase,
      shared.teardown
    );

    /**
     * Which tests opened a PostgreSQL backend, by the suite file that declares
     * them. Every case runs in this file, so the declaring file is read off
     * the stack of the call that opened the backend, which a case makes
     * before its drive first awaits anything.
     */
    const drivenTests = new Map<string, Set<string>>();
    const recordDrive = () => {
      const { currentTestName } = expect.getState();
      const stack = new Error("Locates the declaring suite").stack ?? "";
      const suite = SUITES.find((file) => stack.includes(`/${file}:`));
      if (suite === undefined || currentTestName === undefined) return;
      const tests = drivenTests.get(suite) ?? new Set<string>();
      tests.add(currentTestName);
      drivenTests.set(suite, tests);
    };

    let restore: (() => void) | undefined;
    beforeAll(() => {
      restore = useDefaultReplayBackend(
        openDatabaseReplayBackend(registry.openConnection, recordDrive)
      );
    });

    // A suite none of whose drives reached the database would pass here while
    // checking nothing, so each must have run at least one case on PostgreSQL.
    afterAll(() => {
      restore?.();
      for (const suite of SUITES) {
        expect(drivenTests.get(suite)?.size ?? 0, suite).toBeGreaterThan(0);
      }
    });

    await import("#src/backend/engine/core-cancel.test");
    await import("#src/backend/engine/core-cancel-partial-progress.test");
    await import("#src/backend/engine/core-migration-snapshot.test");
    await import("#src/backend/engine/core-parallel-wait.test");
    await import("#src/backend/engine/core-wait-migrate.test");
    await import("#src/backend/engine/core-wait-split.test");
    await import("#src/backend/engine/entity-eligibility.test");
    await import("#src/backend/engine/testing/replay-runtime.test");
  });
} else {
  describe.skip(`${TITLE} (set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d)`, () => {
    it("runs every database-executor case of the replay suites", () => {
      // Skipped: there is no database to run them on.
    });
  });
}
