import { describe, expect, it } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectReferenceNotUpstreamIssues } from "@wfgraph/shared/graph/workflow-issues";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import {
  defineMigrationSnapshotReplayCases,
  migrationGraph,
} from "#src/backend/engine/core-migration-snapshot.replay-cases";

// `after` reads only nodes upstream of it in every version, so whether its
// input has been produced never depends on which branch a pass drains first.
it.each([false, true])(
  "saves both versions of the Migration graph, each reading only upstream nodes (return to original version: %s)",
  (returnToOriginal) => {
    for (const migrated of [false, true]) {
      const validation = validateWorkflowGraph(
        migrationGraph(migrated, returnToOriginal)
      );
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      expect(
        collectReferenceNotUpstreamIssues({
          nodes: validation.nodes,
          edges: validation.edges,
          catalog: emptyExtensionCatalog,
        })
      ).toEqual([]);
    }
  }
);

describe("under the replay driver", () => {
  defineMigrationSnapshotReplayCases({});
});
