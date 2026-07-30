/**
 * The whole extension surface, assembled once.
 *
 * Nothing registers itself. The host passes its Events, actions and integrations
 * to `createRovaApp`, which calls this, and what comes back has two halves: a
 * catalog, which is JSON and crosses the wire, and the lookups the server keeps.
 *
 * Assembly is where a definition mistake is caught. Each check below throws
 * naming the offender, so the failure lands in the build and the tests of whoever
 * wrote the definition rather than in an editor that quietly lists the wrong
 * thing.
 *
 * Three checks live here, each holding an identifier to one owner: an Event's
 * name, an action's id, an integration's type. Two more belong here and cannot be
 * written yet, because each reads a schema that only a definition carries while
 * the actions arriving here are metadata a registry has already read. An
 * unreadable output schema is caught for now where that registry reads it, in
 * `requireOutputFieldsFromSchema`. An input schema with a required key that no
 * config field fills is caught nowhere. Both land with `defineIntegration`.
 */

import { uniq } from "es-toolkit/array";
import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
  IntegrationMetadata,
} from "@rova/shared/extensions/catalog";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import type { AnyEventDefinition } from "#src/backend/lib/extensions/define-event";

/**
 * An Event as the set holds it.
 *
 * Everything an Event needs is derived at definition, so the registered form is
 * the definition itself, and this alias is what `eventByName` answers with.
 */
export type RegisteredEvent = AnyEventDefinition;

/**
 * What a host hands over.
 *
 * `actions` and `integrations` are metadata rather than definitions while the old
 * registries are still the place a plugin's implementation is found. They become
 * definitions carrying their own handlers when `defineIntegration` lands, and the
 * set gains the lookups that reach those.
 */
export type RovaExtensions = {
  readonly events?: readonly AnyEventDefinition[];
  readonly actions?: readonly ActionMetadata[];
  readonly integrations?: readonly IntegrationMetadata[];
};

export type ExtensionSet = {
  /** The serializable half. This is what /api/extensions sends. */
  readonly catalog: ExtensionCatalog;
  readonly eventByName: (name: string) => RegisteredEvent | undefined;
  /** Every distinct `source.event`, which is the Inngest listener set. */
  readonly sourceEventNames: readonly string[];
};

/**
 * Two Events may not share a name.
 *
 * Identity is the definition object itself, because one `defineEvent` result
 * reaching this list twice is the ordinary case: a host lists an Event under
 * `events` that a plugin it also passed already declares.
 */
function indexEvents(
  events: readonly AnyEventDefinition[]
): Map<string, RegisteredEvent> {
  const byName = new Map<string, RegisteredEvent>();

  for (const event of events) {
    const existing = byName.get(event.name);
    if (existing && existing !== event) {
      throw new Error(
        `Two Events are defined with the name "${event.name}". One Event per name: an app declaring several things that happened declares one Event for each, and an umbrella bus is narrowed with source.when.`
      );
    }
    byName.set(event.name, event);
  }

  return byName;
}

function assertDistinctActionIds(actions: readonly ActionMetadata[]): void {
  const seen = new Set<string>();

  for (const action of actions) {
    if (seen.has(action.id)) {
      throw new Error(
        `Two actions are defined with the id "${action.id}". An action id is "<integration>/<slug>" for an integration's action and whatever the host wrote for its own, and the engine dispatches on it, so it names one implementation.`
      );
    }
    seen.add(action.id);
  }
}

function assertDistinctIntegrationTypes(
  integrations: readonly IntegrationMetadata[]
): void {
  const seen = new Set<string>();

  for (const integration of integrations) {
    if (seen.has(integration.type)) {
      throw new Error(
        `Two integrations are defined with the type "${integration.type}". The type keys an integration's stored credentials, so two of them would read each other's.`
      );
    }
    seen.add(integration.type);
  }
}

/**
 * An absent member is left out rather than set to `undefined`, so the object the
 * server holds is the object the browser decodes: JSON drops an undefined value,
 * and the wire schema's `optionalKey` fields accept an absent key only.
 */
function toEventMetadata(event: RegisteredEvent): EventMetadata {
  return {
    name: event.name,
    label: event.label,
    ...(event.description ? { description: event.description } : {}),
    ...(event.correlationPath
      ? { correlationPath: event.correlationPath }
      : {}),
    payloadFields: event.payloadFields,
  };
}

export function assembleExtensions(input: RovaExtensions): ExtensionSet {
  const eventsByName = indexEvents(input.events ?? []);

  // The built-ins go in first, so a host action colliding with one of them is
  // caught by the same check as any other collision.
  const actions = [...builtInActions, ...(input.actions ?? [])];
  assertDistinctActionIds(actions);

  const integrations = input.integrations ?? [];
  assertDistinctIntegrationTypes(integrations);

  const events = Array.from(eventsByName.values());

  return {
    catalog: {
      events: events.map(toEventMetadata),
      actions,
      integrations,
    },
    eventByName: (name) => eventsByName.get(name),
    sourceEventNames: uniq(events.map((event) => event.source.event)),
  };
}
