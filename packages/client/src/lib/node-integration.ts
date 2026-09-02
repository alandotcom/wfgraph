import { isEmptyObject } from "es-toolkit/predicate";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  isLifecycleNode,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  repairEventConnections,
  type EventConnection,
} from "@wfgraph/shared/lifecycle/event-connections";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";

/**
 * Keeping node connection references pointing at connections that still exist.
 *
 * A stored id goes stale for reasons outside the editor: a connection gets
 * deleted from the settings overlay, or the workflow is opened by someone whose
 * connections differ from the author's. Repair is therefore a normalisation of
 * stored config against the connections that exist right now, and it belongs at
 * the moments those two things meet: loading a workflow, changing the
 * connection list, and choosing an action or Event. Running it from one place is
 * what keeps the no-candidates case answered the same way everywhere, rather
 * than separately by each render effect that would otherwise own a piece of it.
 *
 * Every function here returns its input unchanged when nothing needs fixing.
 * That identity matters: the graph store treats a new node object as an edit
 * and queues an autosave, so a repair that churned would autosave on every
 * render.
 *
 * The catalog is an argument rather than a module read: these are pure
 * reconciliations, and a caller that already holds the surface (the editor's
 * boot catalog, a test fixture) passes it in.
 */

type IntegrationLike = { id: string; type: string };

/**
 * The kind of connection an action needs, which is the catalog's answer for every
 * action alike: a plugin action names the integration it belongs to, and a host's
 * own does the same when it has one.
 */
export function requiredIntegrationType(
  catalog: ExtensionCatalog,
  actionType: string
): string | undefined {
  return findAction(catalog, actionType)?.integration;
}

/**
 * An action node with its `integrationId` reconciled against `integrations`.
 *
 * The rule, deliberately conservative about guessing:
 * - the stored id still exists for the required integration: leave it alone
 * - exactly one connection of the right kind: select it, because there is no
 *   choice to put to the user
 * - no connections of the right kind: clear the id, so the node reports itself
 *   as needing a connection rather than pointing at nothing
 * - two or more: clear a stale id, because picking one would be picking for the
 *   user
 */
export function repairNodeIntegration<T extends WorkflowNode>(
  catalog: ExtensionCatalog,
  node: T,
  integrations: readonly IntegrationLike[]
): T {
  const actionType = readConfigString(node.data.config, "actionType");
  if (!actionType) {
    return node;
  }

  const integrationType = requiredIntegrationType(catalog, actionType);
  if (!integrationType) {
    return node;
  }

  const currentIntegrationId = readConfigString(
    node.data.config,
    "integrationId"
  );
  if (
    currentIntegrationId &&
    integrations.some(
      (integration) =>
        integration.id === currentIntegrationId &&
        integration.type === integrationType
    )
  ) {
    return node;
  }

  const candidates = integrations.filter(
    (integration) => integration.type === integrationType
  );

  if (candidates.length === 1) {
    return withIntegrationId(node, candidates[0].id);
  }
  if (currentIntegrationId) {
    return withIntegrationId(node, undefined);
  }
  return node;
}

function repairLifecycleConnections<T extends WorkflowNode>(
  catalog: ExtensionCatalog,
  node: T,
  integrations: readonly IntegrationLike[]
): T {
  const rules = readLifecycleRules(node.data.config);
  if (!rules) {
    return node;
  }

  const eventNames = new Set([...rules.startEvents, ...rules.cancelEvents]);
  const bindings: EventConnection[] = [...eventNames].map((event) => ({
    event,
    connectionId: rules.connectionIds?.[event],
  }));
  const repaired = repairEventConnections(bindings, catalog, integrations);
  const nextConnectionIds = Object.fromEntries(
    repaired.flatMap((binding) =>
      binding.connectionId ? [[binding.event, binding.connectionId]] : []
    )
  );

  if (sameConnectionIds(rules.connectionIds, nextConnectionIds)) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      config: {
        ...node.data.config,
        lifecycleRules: {
          ...rules,
          connectionIds: isEmptyObject(nextConnectionIds)
            ? undefined
            : nextConnectionIds,
        },
      },
    },
  };
}

function repairWaitConnections<T extends WorkflowNode>(
  catalog: ExtensionCatalog,
  node: T,
  integrations: readonly IntegrationLike[]
): T {
  const subscriptions = readWaitSubscriptions(node.data.config);
  if (subscriptions.length === 0) {
    return node;
  }

  const repaired = repairEventConnections(subscriptions, catalog, integrations);
  if (
    repaired.every(
      (subscription, index) => subscription === subscriptions[index]
    )
  ) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      config: { ...node.data.config, waitFor: repaired },
    },
  };
}

function sameConnectionIds(
  current: Record<string, string> | undefined,
  next: Record<string, string>
): boolean {
  const currentEntries = Object.entries(current ?? {});
  return (
    currentEntries.length === Object.keys(next).length &&
    currentEntries.every(
      ([event, connectionId]) => next[event] === connectionId
    )
  );
}

/**
 * Repair every node's connection references, returning the same array when
 * every node was already correct.
 */
export function repairNodeIntegrations<T extends WorkflowNode>(
  catalog: ExtensionCatalog,
  nodes: T[],
  integrations: readonly IntegrationLike[]
): T[] {
  return mapOrSame(nodes, (node) => {
    const isEventWait =
      node.data.type === "action" &&
      readConfigString(node.data.config, "actionType") ===
        BUILT_IN_ACTION_IDS.wait &&
      readConfigString(node.data.config, "waitMode") === "event";
    return isLifecycleNode(node)
      ? repairLifecycleConnections(catalog, node, integrations)
      : isEventWait
        ? repairWaitConnections(catalog, node, integrations)
        : repairNodeIntegration(catalog, node, integrations);
  });
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
