import { Effect } from "effect";
import { compact } from "es-toolkit/array";
import { resolveEntityEligibility } from "#src/backend/extensions/entity-eligibility-decision";
import {
  EntityStateRejected,
  type AnyEntityDefinition,
} from "#src/backend/extensions/define-entity";
import { resolveEntityState } from "#src/backend/extensions/entity-resolution";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type {
  EntityNodeResolution,
  WorkflowEntities,
} from "#src/backend/engine/entities";
import { engineFailure } from "#src/backend/engine/engine-failure";
import { resolveJsonPath } from "@wfgraph/shared/graph/node-references";
import type { JsonObject } from "@wfgraph/shared/types/json";

function projectState(state: JsonObject, paths: readonly string[]): JsonObject {
  return Object.fromEntries(
    compact(
      paths.map((path) => {
        const value = resolveJsonPath(state, path);
        return value === undefined ? undefined : [path, value];
      })
    )
  );
}

function resolveForData(input: {
  entity: AnyEntityDefinition;
  entityId: string;
  timeoutMs: number;
}) {
  return resolveEntityState({
    definition: input.entity,
    entityId: input.entityId,
    timeoutMs: input.timeoutMs,
  }).pipe(
    Effect.mapError((cause) =>
      engineFailure(
        cause instanceof EntityStateRejected ? "defect" : "failure",
        cause instanceof EntityStateRejected
          ? cause.message
          : `Failed to resolve Entity "${input.entity.type}" for node data`
      )
    ),
    Effect.filterOrFail(
      (state): state is JsonObject => state !== null,
      () =>
        engineFailure(
          "failure",
          `Entity "${input.entity.type}" was not found for node data`
        )
    )
  );
}

/** Builds the engine's node-local Entity resolver from the assembled host surface. */
export function createWorkflowEntities(
  extensions: ExtensionSet
): WorkflowEntities {
  return {
    resolveNode: (input) =>
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

        if (input.condition) {
          const resolved = yield* resolveEntityEligibility({
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

          return {
            decision: resolved.decision,
            values: resolved.state
              ? projectState(resolved.state, input.paths)
              : {},
          } satisfies EntityNodeResolution;
        }

        const state = yield* resolveForData({
          entity,
          entityId: input.entityId,
          timeoutMs: extensions.entityResolverTimeoutMs,
        });
        return {
          decision: { outcome: "eligible" },
          values: projectState(state, input.paths),
        } satisfies EntityNodeResolution;
      }),
  };
}
