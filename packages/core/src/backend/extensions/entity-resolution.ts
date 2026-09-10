/**
 * The bounded call from Workflow Graph into one host-owned Entity resolver.
 *
 * Promise cancellation cannot stop host work already in progress, but the
 * workflow decision must return to its operational-failure path in finite time.
 */

import { Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  EntityStateRejected,
  type AnyEntityDefinition,
} from "#src/backend/extensions/define-entity";

export const DEFAULT_ENTITY_RESOLVER_TIMEOUT_MS = 10_000;

/** Reads the app-owned deadline once, before the runtime starts. */
export function readEntityResolverTimeoutMs(value?: number): number {
  if (value === undefined) {
    return DEFAULT_ENTITY_RESOLVER_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("entityResolverTimeoutMs must be a positive integer");
  }
  return value;
}

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
  timeoutMs: number;
}): Effect.Effect<JsonObject | null, unknown> {
  return Effect.tryPromise({
    try: () => input.definition.resolve({ entityId: input.entityId }),
    catch: (cause) =>
      cause instanceof EntityStateRejected
        ? cause
        : new EntityResolutionFailed(input.definition.type),
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(new EntityResolutionTimedOut(input.definition.type)),
    })
  );
}
