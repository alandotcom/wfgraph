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
  readonly connectionId?: string;
};

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

  let changed = false;
  const next = bindings.map((binding) => {
    const integration = findEvent(catalog, binding.event)?.integration;
    const inherited = integration ? byIntegration.get(integration) : undefined;
    if (!integration || binding.connectionId || !inherited) {
      return binding;
    }
    changed = true;
    return { ...binding, connectionId: inherited };
  });

  return changed ? next : [...bindings];
}
