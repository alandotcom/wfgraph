import { Effect } from "effect";
import { decideEntityEligibility } from "#src/backend/extensions/entity-eligibility-decision";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { engineFailure } from "#src/backend/engine/engine-failure";

/**
 * Builds the engine's decision-only Entity port from the assembled host
 * surface. Looks up the Entity type the engine named, then hands the rest of
 * the decision to `decideEntityEligibility`, mapping a resolver failure to a
 * retryable engine failure and a rejected rule, State or condition to a defect.
 */
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

        return yield* decideEntityEligibility({
          definition: entity,
          entityId: input.entityId,
          condition: input.condition,
          eventName: input.eventName,
          timeoutMs: extensions.entityResolverTimeoutMs,
        }).pipe(
          Effect.mapError((cause) =>
            engineFailure(
              cause._tag === "resolver_failed" ? "failure" : "defect",
              cause.message
            )
          )
        );
      }),
  };
}
