/**
 * The assembled surface, as the engine's dispatch port.
 *
 * The surface knows which action id maps to which step; what a step still needs
 * is the credential store its integration's secrets are read through, and that
 * reads the catalog the same surface carries. Binding the two here is the whole
 * reason a definition answers a factory rather than a step.
 */

import { findAction } from "@rova/shared/extensions/catalog";
import { literalFieldKeys } from "@rova/shared/plugins/action-fields";
import { fetchCredentials } from "#src/backend/lib/credential-fetcher";
import type { ExtensionSet } from "#src/backend/lib/extensions/extension-set";
import type { StepEnvironment } from "#src/backend/lib/steps/step-runner";
import type { WorkflowActions } from "#src/backend/lib/workflow-engine/actions";
import type { RovaRuntime } from "#src/backend/runtime";

export function createWorkflowActions(
  extensions: ExtensionSet,
  runtime: RovaRuntime
): WorkflowActions {
  const app: StepEnvironment = {
    // Which stored key holds which credential is the integration's own
    // declaration, which the catalog carries, so the surface a node was
    // assembled with is the one its secrets are read through.
    credentialsFor: (integrationId) =>
      fetchCredentials(extensions.catalog, runtime, integrationId),
  };

  return {
    stepFor: (actionType) => extensions.stepFor(actionType)?.(app),
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
  };
}
