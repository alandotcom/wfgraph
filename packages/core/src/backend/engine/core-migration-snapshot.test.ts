import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import {
  defineMigrationSnapshotReplayCases,
  migrationGraph,
} from "#src/backend/engine/core-migration-snapshot.replay-cases";

it.each([false, true])(
  "saves both versions of the Migration graph (return to original version: %s)",
  (returnToOriginal) => {
    expect(
      validateWorkflowGraph(migrationGraph(false, returnToOriginal)).valid
    ).toBe(true);
    expect(
      validateWorkflowGraph(migrationGraph(true, returnToOriginal)).valid
    ).toBe(true);
  }
);

describe("under the replay driver", () => {
  defineMigrationSnapshotReplayCases({});
});
