/**
 * The Connection an integration-owned Event must arrive on, as both Lifecycle
 * Rules and Wait subscriptions store it: keyed by Event name, chosen once per
 * integration.
 */

import { omit } from "es-toolkit/object";
import { type ExtensionCatalog, findEvent } from "#src/extensions/catalog";

/** One Event's stored Connection, before any other subscription fields. */
export type EventConnection = {
  readonly event: string;
  readonly connectionId?: string | undefined;
};

export type ConnectionReference = {
  readonly id: string;
  readonly type: string;
};

/**
 * Reconcile one Event's stored Connection with the Connections available now.
 *
 * An existing id is kept when the Connection still exists. A missing id is
 * selected only when one Connection matches the Event's integration. A stale
 * id is removed when zero or several Connections could replace it.
 */
export function repairConnectionId(input: {
  stored?: string | undefined;
  integration: string | undefined;
  connections: readonly ConnectionReference[];
}): string | undefined {
  const { stored, integration, connections } = input;

  if (
    stored &&
    integration &&
    connections.some(
      (connection) =>
        connection.id === stored && connection.type === integration
    )
  ) {
    return stored;
  }

  if (!integration) {
    return undefined;
  }

  const candidates = connections.filter(
    (connection) => connection.type === integration
  );
  return candidates.length === 1 ? candidates[0].id : undefined;
}

type RepairedEventConnection<T extends EventConnection> = Omit<
  T,
  "connectionId"
> & { connectionId?: string };

/** Reconcile every Event binding while preserving each binding's other fields. */
export function repairEventConnections<T extends EventConnection>(
  bindings: readonly T[],
  catalog: ExtensionCatalog,
  connections: readonly ConnectionReference[]
): RepairedEventConnection<T>[] {
  const selectedByIntegration = new Map<string, string>();
  for (const binding of bindings) {
    const integration = findEvent(catalog, binding.event)?.integration;
    if (
      integration &&
      binding.connectionId &&
      connections.some(
        (connection) =>
          connection.id === binding.connectionId &&
          connection.type === integration
      ) &&
      !selectedByIntegration.has(integration)
    ) {
      selectedByIntegration.set(integration, binding.connectionId);
    }
  }

  return bindings.map((binding) => {
    const event = findEvent(catalog, binding.event);
    if (!event) {
      return binding;
    }

    const nextConnectionId = repairConnectionId({
      stored: binding.connectionId,
      integration: event.integration,
      connections,
    });
    const inheritedConnectionId = event.integration
      ? selectedByIntegration.get(event.integration)
      : undefined;
    const repairedConnectionId = inheritedConnectionId ?? nextConnectionId;

    if (repairedConnectionId === binding.connectionId) {
      return binding;
    }

    if (repairedConnectionId) {
      return { ...binding, connectionId: repairedConnectionId };
    }

    const { connectionId: _connectionId, ...rest } = binding;
    return rest;
  });
}

/**
 * Whether a stored Connection still matches the arrival.
 *
 * A host Event never names one, and a stored blank (an unpublished draft that
 * has not picked yet) matches every arrival. A stored id matches only that
 * Connection, so a deleted Connection refuses rather than silently fanning in.
 */
export function connectionMatches(
  stored: string | undefined,
  delivered: string | undefined
): boolean {
  return stored === undefined || stored === delivered;
}

/**
 * The stored Connection for this integration among these Events, if any of
 * them already hold one.
 */
export function connectionIdFor(
  bindings: readonly EventConnection[],
  catalog: ExtensionCatalog,
  integration: string
): string | undefined {
  for (const binding of bindings) {
    if (findEvent(catalog, binding.event)?.integration !== integration) {
      continue;
    }
    if (binding.connectionId) {
      return binding.connectionId;
    }
  }
  return undefined;
}

/**
 * Stamp this Connection onto every Event of this integration. A blank id
 * clears them. Other Events, and fields besides `connectionId`, are left as
 * they were.
 */
export function stampConnection<T extends EventConnection>(input: {
  bindings: readonly T[];
  catalog: ExtensionCatalog;
  integration: string;
  connectionId: string;
}): Array<Omit<T, "connectionId"> & { connectionId?: string }> {
  const { bindings, catalog, integration, connectionId } = input;
  return bindings.map((binding) => {
    if (findEvent(catalog, binding.event)?.integration !== integration) {
      return binding;
    }
    if (connectionId) {
      return { ...binding, connectionId };
    }
    return omit(binding, ["connectionId"]);
  });
}

/**
 * Copy a sibling's Connection onto Events of the same integration that do not
 * yet hold one.
 *
 * Adding Email delivered next to Email sent should not ask for the Resend
 * Connection a second time.
 */
export function inheritConnections<T extends EventConnection>(
  bindings: readonly T[],
  catalog: ExtensionCatalog
): T[] {
  const byIntegration = new Map<string, string>();
  for (const binding of bindings) {
    const integration = findEvent(catalog, binding.event)?.integration;
    if (
      integration &&
      binding.connectionId &&
      !byIntegration.has(integration)
    ) {
      byIntegration.set(integration, binding.connectionId);
    }
  }

  return bindings.map((binding) => {
    const integration = findEvent(catalog, binding.event)?.integration;
    const inherited = integration ? byIntegration.get(integration) : undefined;
    return !integration || binding.connectionId || !inherited
      ? binding
      : { ...binding, connectionId: inherited };
  });
}
