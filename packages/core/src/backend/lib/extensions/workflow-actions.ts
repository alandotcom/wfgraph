/**
 * The assembled surface, as the engine's dispatch port.
 *
 * The surface knows which action id maps to which step; what a step still needs
 * is the credential store its integration's secrets are read through, and that
 * reads the catalog the same surface carries. Binding the two here is the whole
 * reason a definition answers a factory rather than a step.
 */

import { findAction } from "@rova/shared/extensions/catalog";
import { fetchCredentials } from "#src/backend/lib/credential-fetcher";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import type { ExtensionSet } from "#src/backend/lib/extensions/extension-set";
import type { StepEnvironment } from "#src/backend/lib/steps/step-runner";
import type { WorkflowActions } from "#src/backend/lib/workflow-engine/actions";

const systemActionIds = builtInActions.map((action) => action.id);

export function createWorkflowActions(
  extensions: ExtensionSet
): WorkflowActions {
  const app: StepEnvironment = {
    // Which stored key holds which credential is the integration's own
    // declaration, which the catalog carries, so the surface a node was
    // assembled with is the one its secrets are read through.
    credentialsFor: (integrationId) =>
      fetchCredentials(extensions.catalog, integrationId),
  };

  return {
    stepFor: (actionType) => extensions.stepFor(actionType)?.(app),
    labelFor: (actionType) => findAction(extensions.catalog, actionType)?.label,
    systemActionIds,
  };
}
