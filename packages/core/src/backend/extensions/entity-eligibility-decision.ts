/**
 * Decides Entity Eligibility once: check the stored condition against the
 * current State schema, resolve current State, then evaluate. The resolver
 * call is the only effect that reaches outside this module. Every message
 * names the Entity type and the rule, never the resolved State, so no decode
 * ever needs rendering here.
 */

import { Effect } from "effect";
import { checkEntityEligibilityCondition } from "@wfgraph/shared/lifecycle/entity-eligibility";
import {
  type AnyEntityDefinition,
  EntityStateRejected,
} from "#src/backend/extensions/define-entity";
import { resolveEntityState } from "#src/backend/extensions/entity-resolution";
import { toEntityMetadata } from "#src/backend/extensions/extension-set";
import { evaluateSerializedCondition } from "#src/backend/lib/cel/condition-payload";
import type { EntityEligibilityDecision } from "#src/backend/engine/entities";

/**
 * Why the resolver was never reached, or why it was reached and still left no
 * verdict. `resolver_failed` is the one a retry can clear, so it is the one tag
 * a caller separates; `rejected` covers the stored rule the schema refused, the
 * State the host rejected as its own, and the condition CEL could not evaluate,
 * all of which repeat identically on every attempt. This never crosses a wire,
 * so it stays a plain union rather than a `Schema.TaggedError`.
 */
export type EntityEligibilityCause =
  | { readonly _tag: "resolver_failed"; readonly message: string }
  | { readonly _tag: "rejected"; readonly message: string };

/**
 * Resolves current Entity State and evaluates one authored Eligibility
 * condition against it.
 *
 * The condition is the one the Execution or engine node was pinned with, and
 * the host may have changed the Entity's State schema since. A rule the
 * current schema refuses can still evaluate, with a different meaning, so it
 * fails here, before the host resolver is called.
 */
export function decideEntityEligibility(input: {
  definition: AnyEntityDefinition;
  entityId: string;
  condition: string;
  eventName: string | null;
  timeoutMs: number;
}): Effect.Effect<EntityEligibilityDecision, EntityEligibilityCause> {
  return Effect.gen(function* () {
    const check = checkEntityEligibilityCondition(
      toEntityMetadata(input.definition),
      input.condition
    );
    if (!check.valid) {
      return yield* Effect.fail({
        _tag: "rejected",
        message: check.error,
      } as const);
    }

    const state = yield* resolveEntityState({
      definition: input.definition,
      entityId: input.entityId,
      timeoutMs: input.timeoutMs,
    }).pipe(
      // The host rejecting its own State is the Entity's answer and repeats on
      // every attempt. The other two, a resolver that threw and a resolver that
      // missed the deadline, are the host failing to answer, which a retry can
      // clear.
      Effect.mapError((cause) =>
        cause instanceof EntityStateRejected
          ? ({ _tag: "rejected", message: cause.message } as const)
          : ({
              _tag: "resolver_failed",
              message: `Failed to resolve Entity "${input.definition.type}" for Eligibility`,
            } as const)
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
      eventName: input.eventName,
    });
    if (!evaluated.ok) {
      return yield* Effect.fail({
        _tag: "rejected",
        message: `Entity Eligibility could not be evaluated: ${evaluated.error}`,
      } as const);
    }

    return evaluated.value
      ? ({ outcome: "eligible" } as const)
      : ({
          outcome: "exit",
          reason: "entity_condition_not_met",
          checkedAt,
        } as const);
  });
}
