/**
 * The whole extension surface, assembled once.
 *
 * Nothing registers itself: the host hands its definitions to `createRovaApp`,
 * which calls this. What comes back has a catalog, which is JSON and crosses the
 * wire, beside the lookups the server keeps.
 *
 * Assembly holds each identifier to one owner, throwing named so the failure
 * lands in the build of whoever wrote the definition rather than in an editor
 * listing the wrong thing. Two checks the surface wants are missing: an
 * unreadable output schema is caught in `requireOutputFieldsFromSchema` instead,
 * and an input schema with a required key no config field fills is caught
 * nowhere. Both need a schema that only a definition carries, and the actions
 * arriving here are metadata a registry already read.
 */

import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
  IntegrationMetadata,
} from "@rova/shared/extensions/catalog";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";
import type { AnyEventDefinition } from "#src/backend/lib/extensions/define-event";

/**
 * An Event as the set holds it, which is what `eventByName` answers with.
 *
 * Everything an Event needs is derived at definition, so the registered form is
 * the definition itself.
 */
export type RegisteredEvent = AnyEventDefinition;

/**
 * What a host hands over.
 *
 * `actions` and `integrations` are metadata, because a plugin's implementation is
 * found through the registries rather than through anything passed here. An
 * implementation reachable from this set is what `defineIntegration` adds.
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
  /** Every Event, which is the Inngest listener set: one function each. */
  readonly events: readonly RegisteredEvent[];
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

/**
 * Two Events on one source have to be told apart by their payloads.
 *
 * `source.when` is what tells them apart, and an Event declaring none matches
 * every payload on that source. Two such Events would both be delivered every
 * time, which is one arrival counted twice: two runs where the builder configured
 * one, and the same wait woken twice.
 */
function assertSourcesAreDistinguishable(
  events: readonly RegisteredEvent[]
): void {
  const unfilteredBySource = new Map<string, string>();

  for (const event of events) {
    if (event.source.when) {
      continue;
    }

    const existing = unfilteredBySource.get(event.source.event);
    if (existing) {
      throw new Error(
        `Events "${existing}" and "${event.name}" both arrive as "${event.source.event}" and neither narrows it with source.when, so every payload would be delivered as both. Give one of them a filter, or a source name of its own.`
      );
    }
    unfilteredBySource.set(event.source.event, event.name);
  }
}

/**
 * Two Events may not slug to one Inngest function id.
 *
 * The id is `slugify(name)`, so `app/appointment.created` and
 * `app-appointment-created` are the same function to Inngest. It would sync one
 * and drop the other, which reads as an Event that quietly never arrives.
 */
function assertDistinctListenerIds(events: readonly RegisteredEvent[]): void {
  const byId = new Map<string, string>();

  for (const event of events) {
    const id = toListenerFunctionId(event.name);
    const existing = byId.get(id);
    if (existing) {
      throw new Error(
        `Events "${existing}" and "${event.name}" both name the Inngest function "${id}". An Event's listener id is its name slugged, so two names differing only in punctuation collide; rename one.`
      );
    }
    byId.set(id, event.name);
  }
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
  const events = Array.from(eventsByName.values());
  assertSourcesAreDistinguishable(events);
  assertDistinctListenerIds(events);

  // The built-ins go in first, so a host action colliding with one of them is
  // caught by the same check as any other collision.
  const actions = [...builtInActions, ...(input.actions ?? [])];
  assertDistinctActionIds(actions);

  const integrations = input.integrations ?? [];
  assertDistinctIntegrationTypes(integrations);

  return {
    catalog: {
      events: events.map(toEventMetadata),
      actions,
      integrations,
    },
    eventByName: (name) => eventsByName.get(name),
    events,
  };
}
