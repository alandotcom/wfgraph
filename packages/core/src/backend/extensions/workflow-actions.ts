/**
 * The assembled surface, as the engine's dispatch port.
 *
 * The surface knows which action id maps to which step; what a step still needs
 * is the credential store its integration's secrets are read through, which
 * reads the catalog the same surface carries. Binding it here is the whole
 * reason a definition answers a factory rather than a step.
 */

import { Effect } from "effect";
import { findAction } from "@rova/shared/extensions/catalog";
import { literalFieldKeys } from "@rova/shared/plugins/action-fields";
import {
  fetchCredentials,
  type WorkflowCredentials,
} from "#src/backend/extensions/credential-fetcher";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { StepEnvironment } from "#src/backend/extensions/steps/step-runner";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { failureFromUnknown } from "#src/backend/engine/engine-failure";
import type { RovaRuntime } from "#src/backend/runtime";
import { catalogFingerprint as fingerprintCatalog } from "#src/backend/services/workflows/version-digest";

export function createWorkflowActions(
  extensions: ExtensionSet,
  runtime: RovaRuntime
): WorkflowActions {
  // One query per integration for the life of this surface, which the app builds
  // per invocation of the workflow function. A durable runtime re-runs that body
  // once per step of the run, and every handler reads its credentials before its
  // first `step.run`, so a read that remembers nothing is a query per node per
  // step. The values are decrypted secrets: they stay in this closure and never
  // reach `runtime.run`, which would write them into the run's stored state.
  const credentialsByIntegration = new Map<string, WorkflowCredentials>();

  const app: StepEnvironment = {
    // Which stored key holds which credential is the integration's own
    // declaration, which the catalog carries, so the surface a node was
    // assembled with is the one its secrets are read through.
    credentialsFor: (integrationId) =>
      Effect.suspend(() => {
        const known = credentialsByIntegration.get(integrationId);
        if (known) {
          return Effect.succeed(known);
        }

        // Only an answer is kept. A refused read is left for the next node to
        // ask again, since a store that was briefly unreachable clears.
        return Effect.tap(
          fetchCredentials(extensions.catalog, runtime, integrationId),
          (credentials) =>
            Effect.sync(() =>
              credentialsByIntegration.set(integrationId, credentials)
            )
        );
      }),
  };

  return {
    stepFor: (actionType) => {
      const step = extensions.stepFor(actionType)?.(app);
      return step
        ? (input, node) =>
            Effect.mapError(step(input, node), failureFromUnknown)
        : undefined;
    },
    metadataFor: (actionType) => {
      const action = findAction(extensions.catalog, actionType);
      if (!action) {
        return undefined;
      }

      return {
        label: action.label,
        literalConfigKeys: literalFieldKeys(action.configFields),
      };
    },
    catalogFingerprint: () => fingerprintCatalog(extensions.catalog),
  };
}
