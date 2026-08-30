/**
 * The repository contract both persistence backends answer is written once.
 *
 * The cases live under `conformance/`, one file per aggregate. A case reaching
 * past the repositories into one engine's storage belongs in that backend's
 * own file.
 */

import { describe } from "vitest";
import {
  type ConformanceDatabase,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
import { describeWorkflowConformance } from "#src/backend/persistence/conformance/workflows";
import { describeExecutionConformance } from "#src/backend/persistence/conformance/executions";
import { describeIntegrationConformance } from "#src/backend/persistence/conformance/integrations";

// Re-exported so a backend harness and the PostgreSQL-only files have one
// import to reach for, rather than two paths into the same support.
export {
  conformanceCipher,
  connect,
  seedPublishedWorkflow,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
export type {
  ConformanceConnection,
  ConformanceDatabase,
} from "#src/backend/persistence/conformance/support";

export type PersistenceConformanceHarness = {
  /** Names the run, as in "native SQLite" or "PostgreSQL". */
  readonly backend: string;
  /** A migrated database the calling case owns, empty of any other case's rows. */
  readonly createDatabase: () => Promise<ConformanceDatabase>;
  /** Called once every case is done, for a harness holding something shared. */
  readonly teardown?: () => Promise<void>;
  /**
   * Set to skip the run and say why. It reaches the suite title because a
   * reporter prints that whether the suite ran or not. A console line from a
   * skipped file may go unseen.
   */
  readonly skip?: string;
};

export function describePersistenceConformance(
  harness: PersistenceConformanceHarness
): void {
  const title = `${harness.backend} persistence conformance`;
  const describeSuite = harness.skip ? describe.skip : describe;

  describeSuite(harness.skip ? `${title} (${harness.skip})` : title, () => {
    const registry = usePersistenceRegistry(
      harness.createDatabase,
      harness.teardown
    );

    describeWorkflowConformance(registry);
    describeExecutionConformance(registry);
    describeIntegrationConformance(registry);
  });
}
