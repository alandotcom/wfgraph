import { Effect } from "effect";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import {
  EntityStateRejected,
  type AnyEntityDefinition,
} from "#src/backend/extensions/define-entity";
import { resolveEntityState } from "#src/backend/extensions/entity-resolution";
import { evaluateSerializedCondition } from "#src/backend/lib/cel/condition-payload";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import { entityEligibilityConditionId } from "#src/backend/lib/entity-eligibility";

/** The server-only Event data needed to establish a guarded run's identity. */
export type EntityBindingEvent = {
  readonly name: string;
  readonly entityBindings?: AnyEventDefinition["entities"];
  readonly validatedPayload?: unknown;
};

export type TrackedEntitySelection = {
  readonly entityType: string;
  readonly entityId: string;
  readonly definition: AnyEntityDefinition;
};

export type AdmissionEligibilityRefusal = {
  readonly reason: EntityEligibilityReason;
  readonly entityType: string;
  readonly conditionId: string;
  readonly checkedAt: string;
};

export type GuardedStartDecision = {
  readonly entity: TrackedEntitySelection;
  readonly refusal?: AdmissionEligibilityRefusal | undefined;
};

function configurationFailure(message: string) {
  return new InternalFailure({
    error: "Failed to evaluate Entity Eligibility",
    cause: new Error(message),
  });
}

/**
 * Selects the immutable Entity identity for a guarded lifecycle Event.
 *
 * Publish owns configuration validation. A missing binding here therefore means
 * the deployed executable extension surface no longer matches the version that
 * preflight accepted, and is an operational failure rather than ineligibility.
 */
export const selectTrackedEntity = Effect.fn("selectTrackedEntity")(
  function* (input: { rules: LifecycleRules; event: EntityBindingEvent }) {
    const tracked = input.rules.trackedEntity;
    if (!tracked) {
      return undefined;
    }

    const bindingName = tracked.bindings[input.event.name];
    const binding = bindingName
      ? input.event.entityBindings?.[bindingName]
      : undefined;
    if (!binding || binding.entity.type !== tracked.type) {
      return yield* configurationFailure(
        `Event "${input.event.name}" cannot select tracked Entity "${tracked.type}" from the published binding`
      );
    }
    if (!("validatedPayload" in input.event)) {
      return yield* configurationFailure(
        `Event "${input.event.name}" has no validated payload for its Entity binding`
      );
    }

    const entityId = yield* Effect.try({
      try: () => binding.selectEntityId(input.event.validatedPayload),
      catch: () =>
        configurationFailure(
          `Event "${input.event.name}" could not select an Entity ID`
        ),
    });

    return {
      entityType: tracked.type,
      entityId,
      definition: binding.entity,
    } satisfies TrackedEntitySelection;
  }
);

/** Evaluates admission for an identity already selected from the Event. */
export const evaluateSelectedEntityAdmission = Effect.fn(
  "evaluateSelectedEntityAdmission"
)(function* (input: {
  rules: LifecycleRules;
  eventName: string;
  entity: TrackedEntitySelection;
}) {
  const { entity } = input;
  const eligibility = input.rules.entityEligibility;
  if (!eligibility?.checkpoints.includes("before-execution")) {
    return { entity } satisfies GuardedStartDecision;
  }

  const conditionId = entityEligibilityConditionId(eligibility.condition);
  const state = yield* resolveEntityState({
    definition: entity.definition,
    entityId: entity.entityId,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InternalFailure({
          error:
            cause instanceof EntityStateRejected
              ? cause.message
              : `Failed to resolve Entity "${entity.entityType}" for Eligibility`,
        })
    )
  );

  if (state === null) {
    return {
      entity,
      refusal: {
        reason: "entity_not_found",
        entityType: entity.entityType,
        conditionId,
        checkedAt: new Date().toISOString(),
      },
    } satisfies GuardedStartDecision;
  }

  const evaluated = evaluateSerializedCondition({
    model: eligibility.condition,
    payload: state,
    eventName: input.eventName,
  });
  if (!evaluated.ok) {
    return yield* configurationFailure(
      `Entity Eligibility could not be evaluated: ${evaluated.error}`
    );
  }
  if (!evaluated.value) {
    return {
      entity,
      refusal: {
        reason: "entity_condition_not_met",
        entityType: entity.entityType,
        conditionId,
        checkedAt: new Date().toISOString(),
      },
    } satisfies GuardedStartDecision;
  }

  return { entity } satisfies GuardedStartDecision;
});

/**
 * Establishes a guarded start's identity and, when configured, evaluates the
 * admission checkpoint against current host-owned Entity State.
 */
export const evaluateGuardedStart = Effect.fn("evaluateGuardedStart")(
  function* (input: { rules: LifecycleRules; event: EntityBindingEvent }) {
    const entity = yield* selectTrackedEntity(input);
    return entity
      ? yield* evaluateSelectedEntityAdmission({
          rules: input.rules,
          eventName: input.event.name,
          entity,
        })
      : undefined;
  }
);
