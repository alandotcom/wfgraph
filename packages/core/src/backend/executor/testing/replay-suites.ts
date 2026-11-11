/**
 * The ten replay suites' cases, with every drive run through one persistence
 * backend: each pass is claimed with `claimDue`, replayed over the memo rows,
 * woken through `wakePark`, and released with `releasePass`, all at the
 * harness's virtual clock.
 *
 * Each suite declares those cases in a `*.replay-cases.ts` module as a function
 * of the executor, which the suite file calls with an in-memory backend and
 * this runner calls with a backend over the database. A case holds the same
 * assertions on every backend as it does in memory.
 */

import { afterAll, describe, expect, it } from "vitest";
import { defineArrivingEventReplayCases } from "#src/backend/engine/core-arriving-event.replay-cases";
import { defineCancelPartialProgressReplayCases } from "#src/backend/engine/core-cancel-partial-progress.replay-cases";
import { defineCancelReplayCases } from "#src/backend/engine/core-cancel.replay-cases";
import { defineMigrationSnapshotReplayCases } from "#src/backend/engine/core-migration-snapshot.replay-cases";
import { defineParallelWaitReplayCases } from "#src/backend/engine/core-parallel-wait.replay-cases";
import { defineWaitMigrateReplayCases } from "#src/backend/engine/core-wait-migrate.replay-cases";
import { defineWaitSplitReplayCases } from "#src/backend/engine/core-wait-split.replay-cases";
import { defineEntityEligibilityReplayCases } from "#src/backend/engine/entity-eligibility.replay-cases";
import { defineHostActionMemoReplayCases } from "#src/backend/engine/host-action-memo.replay-cases";
import type { ReplayCases } from "#src/backend/engine/testing/replay-runtime";
import { defineReplayRuntimeCases } from "#src/backend/engine/testing/replay-runtime.replay-cases";
import { openDatabaseReplayBackend } from "#src/backend/executor/testing/database-replay-backend";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";

/** Each suite's cases, by the path of the suite file under `backend/`. */
const SUITES: ReadonlyArray<{ suite: string; cases: ReplayCases }> = [
  {
    suite: "engine/core-arriving-event.test.ts",
    cases: defineArrivingEventReplayCases,
  },
  { suite: "engine/core-cancel.test.ts", cases: defineCancelReplayCases },
  {
    suite: "engine/core-cancel-partial-progress.test.ts",
    cases: defineCancelPartialProgressReplayCases,
  },
  {
    suite: "engine/core-migration-snapshot.test.ts",
    cases: defineMigrationSnapshotReplayCases,
  },
  {
    suite: "engine/core-parallel-wait.test.ts",
    cases: defineParallelWaitReplayCases,
  },
  {
    suite: "engine/core-wait-migrate.test.ts",
    cases: defineWaitMigrateReplayCases,
  },
  {
    suite: "engine/core-wait-split.test.ts",
    cases: defineWaitSplitReplayCases,
  },
  {
    suite: "engine/entity-eligibility.test.ts",
    cases: defineEntityEligibilityReplayCases,
  },
  {
    suite: "engine/host-action-memo.test.ts",
    cases: defineHostActionMemoReplayCases,
  },
  {
    suite: "engine/testing/replay-runtime.test.ts",
    cases: defineReplayRuntimeCases,
  },
];

export function describeReplaySuites(
  harness: PersistenceConformanceHarness
): void {
  const title = `replay suites on ${harness.backend}`;

  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every case of the replay suites", () => {
        // Skipped: there is no database to run them on.
      });
    });
    return;
  }

  describe(title, () => {
    const registry = usePersistenceRegistry(
      harness.createDatabase,
      harness.teardown
    );

    /** The tests that opened a database backend, by the suite they belong to. */
    const drivenTests = new Map<string, Set<string>>();

    // A suite none of whose drives reached the database would pass here while
    // checking nothing, so each must have run at least one case on it.
    afterAll(() => {
      for (const { suite } of SUITES) {
        expect(drivenTests.get(suite)?.size ?? 0, suite).toBeGreaterThan(0);
      }
    });

    for (const { suite, cases } of SUITES) {
      const recordDrive = () => {
        const { currentTestName } = expect.getState();
        if (currentTestName === undefined) return;
        const tests = drivenTests.get(suite) ?? new Set<string>();
        tests.add(currentTestName);
        drivenTests.set(suite, tests);
      };

      describe(suite, () => {
        cases({
          openBackend: openDatabaseReplayBackend(
            registry.openConnection,
            recordDrive
          ),
        });
      });
    }
  });
}
