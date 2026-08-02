import { getExtensionCatalog } from "#src/lib/extensions";
import { findAction } from "@rova/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { readConfigString } from "@rova/shared/graph/node-config";

/**
 * Keeping a node's `integrationId` pointing at a connection that still exists.
 *
 * A stored id goes stale for reasons outside the editor: a connection gets
 * deleted from the settings overlay, or the workflow is opened by someone whose
 * connections differ from the author's. Repair is therefore a normalisation of
 * stored config against the connections that exist right now, and it belongs at
 * the moments those two things meet: loading a workflow, changing the
 * connection list, and choosing an action. Running it from one place is what
 * keeps the no-candidates case answered the same way everywhere, rather than
 * separately by each render effect that would otherwise own a piece of it.
 *
 * Every function here returns its input unchanged when nothing needs fixing.
 * That identity matters: the graph store treats a new node object as an edit
 * and queues an autosave, so a repair that churned would autosave on every
 * render.
 */

type IntegrationLike = { id: string; type: string };


/**
 * The kind of connection an action needs, which is the catalog's answer for every
 * action alike: a plugin action names the integration it belongs to, and a host's
 * own does the same when it has one.
 */
export function requiredIntegrationType(
  actionType: string
): string | undefined {
  return findAction(getExtensionCatalog(), actionType)?.integration;
}

/**
 * The node with its `integrationId` reconciled against `integrations`.
 *
 * The rule, deliberately conservative about guessing:
 * - the stored id still exists: leave it alone
 * - exactly one connection of the right kind: select it, because there is no
 *   choice to put to the user
 * - no connections of the right kind: clear the id, so the node reports itself
 *   as needing a connection rather than pointing at nothing
 * - two or more: leave it alone, because picking one would be picking for the
 *   user
 */
export function repairNodeIntegration<T extends WorkflowNode>(
  node: T,
  integrations: readonly IntegrationLike[]
): T {
  const actionType = readConfigString(node.data.config, "actionType");
  if (!actionType) {
    return node;
  }

  const integrationType = requiredIntegrationType(actionType);
  if (!integrationType) {
    return node;
  }

  const currentIntegrationId = readConfigString(
    node.data.config,
    "integrationId"
  );
  if (
    currentIntegrationId &&
    integrations.some((integration) => integration.id === currentIntegrationId)
  ) {
    return node;
  }

  const candidates = integrations.filter(
    (integration) => integration.type === integrationType
  );

  if (candidates.length === 1) {
    return withIntegrationId(node, candidates[0].id);
  }
  if (candidates.length === 0 && currentIntegrationId) {
    return withIntegrationId(node, undefined);
  }
  return node;
}

/**
 * `repairNodeIntegration` across a whole graph, returning the same array when
 * every node was already correct.
 */
export function repairNodeIntegrations<T extends WorkflowNode>(
  nodes: T[],
  integrations: readonly IntegrationLike[]
): T[] {
  let changed = false;
  const repaired = nodes.map((node) => {
    const next = repairNodeIntegration(node, integrations);
    if (next !== node) {
      changed = true;
    }
    return next;
  });

  return changed ? repaired : nodes;
}

function withIntegrationId<T extends WorkflowNode>(
  node: T,
  integrationId: string | undefined
): T {
  return {
    ...node,
    data: {
      ...node.data,
      config: { ...node.data.config, integrationId },
    },
  };
}
