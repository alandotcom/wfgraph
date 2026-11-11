/**
 * Event deliveries on the database executor, on one persistence backend. A
 * runner per backend calls `describeDeliveryCases`, so every backend answers
 * the same assertions: the worker loop's cases in `delivery-loop-cases.ts`
 * and the pass-by-pass cases in `delivery-crash-cases.ts` and
 * `delivery-catch-up-cases.ts`, all over the harness in `delivery-fixtures.ts`.
 */

import { describe, it } from "vitest";
import { describeDeliveryCatchUpCases } from "#src/backend/executor/testing/delivery-catch-up-cases";
import { describeDeliveryCrashCases } from "#src/backend/executor/testing/delivery-crash-cases";
import { useDeliveryHarness } from "#src/backend/executor/testing/delivery-fixtures";
import { describeDeliveryLoopCases } from "#src/backend/executor/testing/delivery-loop-cases";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";

export function describeDeliveryCases(
  harness: PersistenceConformanceHarness
): void {
  const title = `database executor deliveries on ${harness.backend}`;
  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every delivery case", () => {
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
    const open = useDeliveryHarness(registry.openDatabase);
    describeDeliveryLoopCases(open);
    describeDeliveryCrashCases(open);
    describeDeliveryCatchUpCases(open);
  });
}
