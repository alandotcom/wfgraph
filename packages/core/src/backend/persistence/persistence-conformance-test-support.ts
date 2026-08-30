/**
 * The repository contract both persistence backends answer, written once.
 *
 * A backend passes a harness that mints an isolated, migrated database per case.
 * The cases themselves live beside this under `conformance/`, one file per
 * aggregate, because a case is about workflows or about runs or about
 * integrations and almost never about two of them.
 *
 * A case that reaches past the repositories into one engine's own storage
 * belongs in that backend's own file, not here.
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
  /** A fresh, empty, migrated database the calling case owns. */
  readonly createDatabase: () => Promise<ConformanceDatabase>;
  /**
   * Set to skip the run and say why. It reaches the suite title, because a
   * reporter prints that whether the suite ran or not, while a console line
   * from a skipped file may go unseen.
   */
  readonly skip?: string;
};

export function describePersistenceConformance(
  harness: PersistenceConformanceHarness
): void {
  const title = `${harness.backend} persistence conformance`;
  const describeSuite = harness.skip ? describe.skip : describe;

  describeSuite(harness.skip ? `${title} (${harness.skip})` : title, () => {
    const registry = usePersistenceRegistry(harness.createDatabase);

    describeWorkflowConformance(registry);
    describeExecutionConformance(registry);
    describeIntegrationConformance(registry);
  });
}
