/**
 * The eight replay suites, with every drive under the database executor run
 * through one persistence backend: each pass is claimed with `claimDue`,
 * replayed over the memo rows, woken through `resolvePark`, and released with
 * `releasePass`, all at the harness's virtual clock.
 *
 * The suites are imported rather than copied, so a case holds the same
 * assertions on every backend as it does in memory. Their Inngest-executor
 * cases run too, unchanged and without a database. A case that opens its own
 * backend keeps it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useDefaultReplayBackend } from "#src/backend/engine/testing/replay-database-executor";
import { openDatabaseReplayBackend } from "#src/backend/executor/testing/database-replay-backend";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";

/** The suites, by the path of the file each is declared in, under `backend/`. */
const SUITES = [
  "engine/core-cancel.test.ts",
  "engine/core-cancel-partial-progress.test.ts",
  "engine/core-migration-snapshot.test.ts",
  "engine/core-parallel-wait.test.ts",
  "engine/core-wait-migrate.test.ts",
  "engine/core-wait-split.test.ts",
  "engine/entity-eligibility.test.ts",
  "engine/testing/replay-runtime.test.ts",
] as const;

/**
 * Imports one suite so its cases register under the describe that is
 * collecting. The `?backend=` query gives the suite a module id of its own per
 * backend: with vitest's `isolate: false` a worker keeps the module loaded, and
 * a plain re-import would register no cases.
 */
async function importSuite(suite: string, backend: string): Promise<void> {
  const query = new URLSearchParams({ backend }).toString();
  await import(/* @vite-ignore */ `../../${suite}?${query}`);
}

/** The suite whose file a stack passes through, by any module id of it. */
function declaringSuite(stack: string): string | undefined {
  return SUITES.find(
    (suite) => stack.includes(`/${suite}:`) || stack.includes(`/${suite}?`)
  );
}

export function describeReplaySuites(
  harness: PersistenceConformanceHarness
): void {
  const title = `replay suites on ${harness.backend}`;

  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every database-executor case of the replay suites", () => {
        // Skipped: there is no database to run them on.
      });
    });
    return;
  }

  // The factory is awaited while the file is collected, so the suites it
  // imports register their cases inside this one, under its hooks.
  describe(title, async () => {
    const registry = usePersistenceRegistry(
      harness.createDatabase,
      harness.teardown
    );

    /**
     * Which tests opened a database backend, by the suite file that declares
     * them. Every case runs in the runner's file, so the declaring file is
     * read off the stack of the call that opened the backend, which a case
     * makes before its drive first awaits anything.
     */
    const drivenTests = new Map<string, Set<string>>();
    const recordDrive = () => {
      const { currentTestName } = expect.getState();
      const suite = declaringSuite(
        new Error("Locates the declaring suite").stack ?? ""
      );
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
    // checking nothing, so each must have run at least one case on it.
    afterAll(() => {
      restore?.();
      for (const suite of SUITES) {
        expect(drivenTests.get(suite)?.size ?? 0, suite).toBeGreaterThan(0);
      }
    });

    for (const suite of SUITES) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each suite declares its cases in order, one file at a time
      await importSuite(suite, harness.backend);
    }
  });
}
