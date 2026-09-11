import { Effect } from "effect";
import { checkEntityEligibilityCondition } from "@wfgraph/shared/lifecycle/entity-eligibility";
import {
  type ExtensionSet,
  toEntityMetadata,
} from "#src/backend/extensions/extension-set";
import { EntityStateRejected } from "#src/backend/extensions/define-entity";
import { resolveEntityState } from "#src/backend/extensions/entity-resolution";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { engineFailure } from "#src/backend/engine/engine-failure";
import { evaluateSerializedCondition } from "#src/backend/lib/cel/condition-payload";

/** Builds the engine's decision-only Entity port from the assembled host surface. */
export function createWorkflowEntities(
  extensions: ExtensionSet
): WorkflowEntities {
  return {
    evaluateEligibility: (input) =>
      Effect.gen(function* () {
        const entity = extensions.entityByType(input.entityType);
        if (!entity) {
          return yield* Effect.fail(
            engineFailure(
              "defect",
              `Entity "${input.entityType}" is unavailable for this workflow run`
            )
          );
        }

        // The condition is the one the version or Execution was pinned with, and
        // the host may have changed the Entity's State schema since. A rule the
        // current schema refuses can still evaluate, with a different meaning,
        // so it fails here, before the host resolver is called.
        const check = checkEntityEligibilityCondition(
          toEntityMetadata(entity),
          input.condition
        );
        if (!check.valid) {
          return yield* Effect.fail(engineFailure("defect", check.error));
        }

        const state = yield* resolveEntityState({
          definition: entity,
          entityId: input.entityId,
          timeoutMs: extensions.entityResolverTimeoutMs,
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof EntityStateRejected
              ? engineFailure("defect", cause.message)
              : engineFailure(
                  "failure",
                  `Failed to resolve Entity "${input.entityType}" for Eligibility`
                )
          )
        );
        const checkedAt = new Date().toISOString();
        if (state === null) {
          return {
            outcome: "exit",
            reason: "entity_not_found",
            checkedAt,
          } as const;
        }

        const evaluated = evaluateSerializedCondition({
          model: input.condition,
          payload: state,
          eventName: input.eventName ?? "",
        });
        if (!evaluated.ok) {
          return yield* Effect.fail(
            engineFailure(
              "defect",
              `Entity Eligibility could not be evaluated: ${evaluated.error}`
            )
          );
        }

        return evaluated.value
          ? ({ outcome: "eligible" } as const)
          : ({
              outcome: "exit",
              reason: "entity_condition_not_met",
              checkedAt,
            } as const);
      }),
  };
}
