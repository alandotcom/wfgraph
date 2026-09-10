/**
 * The bounded call from Workflow Graph into one host-owned Entity resolver.
 *
 * Promise cancellation cannot stop host work already in progress, but the
 * workflow decision must return to its operational-failure path in finite time.
 */

import { Duration, Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  EntityStateRejected,
  type AnyEntityDefinition,
} from "#src/backend/extensions/define-entity";

export const ENTITY_RESOLVER_TIMEOUT = Duration.seconds(10);

/** A resolver rejected without exposing host error text past the boundary. */
export class EntityResolutionFailed extends Error {
  readonly entityType: string;

  constructor(entityType: string) {
    super(`Entity "${entityType}" resolver failed`);
    this.name = "EntityResolutionFailed";
    this.entityType = entityType;
  }
}

/** A resolver did not settle before Workflow Graph's decision deadline. */
export class EntityResolutionTimedOut extends Error {
  readonly entityType: string;

  constructor(entityType: string) {
    super(`Entity "${entityType}" resolver timed out`);
    this.name = "EntityResolutionTimedOut";
    this.entityType = entityType;
  }
}

/** Resolves current Entity State without allowing a host promise to hang a run. */
export function resolveEntityState(input: {
  definition: AnyEntityDefinition;
  entityId: string;
}): Effect.Effect<JsonObject | null, unknown> {
  return Effect.tryPromise({
    try: () => input.definition.resolve({ entityId: input.entityId }),
    catch: (cause) =>
      cause instanceof EntityStateRejected
        ? cause
        : new EntityResolutionFailed(input.definition.type),
  }).pipe(
    Effect.timeoutOrElse({
      duration: ENTITY_RESOLVER_TIMEOUT,
      orElse: () =>
        Effect.fail(new EntityResolutionTimedOut(input.definition.type)),
    })
  );
}
