/**
 * The Group boundary matrix run through the draft save and the publication gate.
 * `group-contract.test.ts` in @wfgraph/shared runs the same cases through
 * `groupContractViolations`, and every verdict here must match that one.
 */

import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import {
  checkPublishReadiness,
  collectSynchronousPublicationFailures,
} from "#src/backend/services/workflows/publish-checks";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { serializeWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import {
  groupContractMatrix,
  MATRIX_LOOKUP_ACTION,
} from "@wfgraph/shared/graph/group-contract-test-support";

const lookupAction = {
  id: MATRIX_LOOKUP_ACTION,
  label: "Lookup",
  description: "Reads a record",
  category: "Custom",
  configFields: [],
  outputFields: [],
};

// Publication only ever reads a saved draft, so the full readiness check runs
// on the cases the save accepts whose steps are all lookups.
const savedLookupOnly = groupContractMatrix.filter(
  (matrixCase) =>
    matrixCase.savesAsDraft &&
    matrixCase.nodes.every(
      (node) =>
        node.data.type !== "action" ||
        node.data.config?.actionType === MATRIX_LOOKUP_ACTION
    )
);

describe("Group boundary matrix through publication", () => {
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      stubExtensionCatalog({ actions: [lookupAction] }),
      stubIntegrationRepo({ typesByIds: () => Effect.succeed({}) })
    )
  )((it) => {
    // The publication battery with every other check's failures set aside, so
    // a fixture's half-built Condition or Wait cannot hide the Group verdict.
    for (const matrixCase of groupContractMatrix) {
      it(`${matrixCase.name}: the publication battery agrees with the shared verdict`, () => {
        const [firstViolation] = groupContractViolations(matrixCase);
        const groupFailures = collectSynchronousPublicationFailures({
          nodes: matrixCase.nodes,
          edges: matrixCase.edges,
          catalog: { ...emptyExtensionCatalog, actions: [lookupAction] },
        }).filter((failure) => failure.kind === "invalid_group");

        assert.strictEqual(
          groupFailures.length > 0,
          firstViolation !== undefined
        );
        if (firstViolation) {
          assert.isTrue(
            groupFailures[0]?.error.startsWith(firstViolation.message)
          );
        }
      });
    }

    for (const matrixCase of groupContractMatrix) {
      it.effect(
        `${matrixCase.name}: the draft save ${matrixCase.savesAsDraft ? "accepts" : "refuses"} it`,
        () =>
          Effect.gen(function* () {
            const saved = yield* prepareGraphSave({
              graph: serializeWorkflowGraphData(matrixCase),
            }).pipe(Effect.result);

            assert.strictEqual(
              saved._tag === "Success",
              matrixCase.savesAsDraft
            );
          })
      );
    }

    for (const matrixCase of savedLookupOnly) {
      it.effect(`${matrixCase.name}: checkPublishReadiness verdict`, () =>
        Effect.gen(function* () {
          const [firstViolation] = groupContractViolations(matrixCase);
          const outcome = yield* checkPublishReadiness({
            nodes: matrixCase.nodes,
            edges: matrixCase.edges,
          }).pipe(Effect.result);

          if (!firstViolation) {
            assert.strictEqual(outcome._tag, "Success");
            return;
          }
          assert.strictEqual(outcome._tag, "Failure");
          if (outcome._tag === "Failure") {
            assert.instanceOf(outcome.failure, InvalidInput);
            assert.isTrue(
              outcome.failure.error.startsWith(firstViolation.message)
            );
          }
        })
      );
    }
  });
});
