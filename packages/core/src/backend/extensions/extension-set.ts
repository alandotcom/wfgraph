/**
 * The whole extension surface, assembled once.
 *
 * Nothing registers itself: the host hands its definitions to `createWfGraphApp`,
 * which calls this. What comes back has a catalog, which is JSON and crosses the
 * wire, beside the lookups the server keeps.
 *
 * Assembly holds each identifier to one owner, throwing named so the failure
 * lands in the build of whoever wrote the definition rather than in an editor
 * listing the wrong thing. It is also where an integration's actions get their
 * ids and their derived field lists, because the id is `${type}/${slug}` and the
 * slug is a record key the definition never spells out twice.
 */

import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
  IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";
import {
  type ActionConfigFieldBase,
  flattenConfigFields,
} from "@wfgraph/shared/plugins/action-fields";
import type { StepFactory } from "#src/backend/extensions/steps/step-runner";
import { builtInActions } from "#src/backend/extensions/built-ins";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";
import type { ActionDefinition } from "#src/backend/extensions/define-action";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import {
  checkIntegration,
  type IntegrationDefinition,
} from "#src/backend/extensions/define-integration";
import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";

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
 * Every kind arrives as a definition carrying its own implementation, so this set
 * answers for both halves of the surface and nothing has to be registered
 * anywhere for it to. An integration brings a step per action and a connection
 * test; a host's own action, from `defineAction`, brings its handler.
 */
export type WfGraphExtensions = {
  readonly events?: readonly AnyEventDefinition[];
  readonly integrations?: readonly IntegrationDefinition[];
  readonly actions?: readonly ActionDefinition[];
};

export type ExtensionSet = {
  /** The serializable half. This is what /api/extensions sends. */
  readonly catalog: ExtensionCatalog;
  /**
   * Server-only, keyed by the same action ids the catalog carries.
   *
   * A factory rather than a step: a handler's Effect asks for services the app's
   * runtime carries, and assembly happens before that runtime exists. The engine's
   * action port is where the two meet.
   */
  readonly stepFor: (actionId: string) => StepFactory | undefined;
  readonly connectionTestFor: (
    type: string
  ) => IntegrationTestLoader | undefined;
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

/**
 * Two actions may not share an id.
 *
 * The whole surface goes through this in one list, so a host action colliding with
 * a built-in, with an integration's, or with another host action is one failure
 * with one message. The engine dispatches on the id, so it names one
 * implementation.
 */
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

/** The field types the editor draws with a template picker. */
const TEMPLATE_FIELD_TYPES = new Set<ActionConfigFieldBase["type"]>([
  "template-input",
  "template-textarea",
]);

/**
 * `literal` and a template-picker field type contradict each other.
 *
 * The editor keys its renderer on `field.type` alone, so a `template-input` or
 * `template-textarea` field draws the picker regardless of `literal`, inviting a
 * builder to insert `{{@node.field}}` into a value the engine then hands the
 * vendor unresolved. `literal` only makes sense on a field type the renderer
 * never offers a template into.
 */
function assertLiteralFieldsRenderNoTemplatePicker(
  action: ActionMetadata
): void {
  for (const field of flattenConfigFields(action.configFields)) {
    if (field.literal === true && TEMPLATE_FIELD_TYPES.has(field.type)) {
      throw new Error(
        `Action "${action.id}" marks its "${field.key}" field literal, but a ${field.type} field always renders the template picker. Give the field a "text" type, or drop literal: true.`
      );
    }
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

/**
 * Where the two halves an integration's action has are put.
 *
 * The catalog half crosses the wire; the step half stays here for `stepFor` to
 * answer with, keyed by the same id.
 */
type Assembly = {
  actions: ActionMetadata[];
  steps: Map<string, StepFactory>;
  tests: Map<string, IntegrationTestLoader>;
};

/**
 * An integration's actions, as the catalog lists them and as the engine runs them.
 *
 * `checkIntegration` is where the action id is computed and where the definition
 * is held to what the editor and the engine need: nothing before it holds both the
 * integration's type and the slug.
 */
function readIntegration(
  integration: IntegrationDefinition,
  into: Assembly
): IntegrationMetadata {
  for (const { id, step, outputFields } of checkIntegration(integration)) {
    into.actions.push({
      id,
      label: step.label,
      description: step.description,
      category: step.category,
      integration: integration.type,
      configFields: step.configFields,
      outputFields,
    });
    into.steps.set(id, step.implement(id));
  }

  if (integration.test) {
    into.tests.set(integration.type, integration.test);
  }

  return {
    type: integration.type,
    label: integration.label,
    description: integration.description,
    credentialFields: integration.credentials,
    hasTest: integration.test !== undefined,
  };
}

/**
 * A host's own action, in both halves the same way an integration's is.
 *
 * `defineAction` has already derived the config fields and the output fields from
 * the author's schemas and normalized the rest, so the metadata is read straight
 * off the definition. Its step is built there too, because an action carries its
 * own id, and it goes into the same map an integration's does, so dispatch has
 * one kind of thing to find.
 */
function readHostAction(action: ActionDefinition, into: Assembly): void {
  into.actions.push({
    id: action.id,
    label: action.label,
    description: action.description,
    category: action.category,
    ...(action.logoUrl ? { logoUrl: action.logoUrl } : {}),
    configFields: action.configFields ?? [],
    outputFields: action.outputFields ?? [],
  });
  into.steps.set(action.id, action.implement);
}

export function assembleExtensions(input: WfGraphExtensions): ExtensionSet {
  const eventsByName = indexEvents(input.events ?? []);
  const events = Array.from(eventsByName.values());
  assertSourcesAreDistinguishable(events);
  assertDistinctListenerIds(events);

  // The built-ins go in first, so anything colliding with one of them is caught
  // by the same check as any other collision.
  // Neither carries a step: the engine dispatches to Condition and Wait itself
  // during traversal, so `stepFor` never needs an entry for them and the map
  // starts empty.
  const into: Assembly = {
    actions: [...builtInActions],
    steps: new Map(),
    tests: new Map(),
  };

  const integrations = (input.integrations ?? []).map((integration) =>
    readIntegration(integration, into)
  );

  for (const action of input.actions ?? []) {
    readHostAction(action, into);
  }

  assertDistinctActionIds(into.actions);
  assertDistinctIntegrationTypes(integrations);
  for (const action of into.actions) {
    assertLiteralFieldsRenderNoTemplatePicker(action);
  }

  return {
    catalog: {
      events: events.map(toEventMetadata),
      actions: into.actions,
      integrations,
    },
    stepFor: (actionId) => into.steps.get(actionId),
    connectionTestFor: (type) => into.tests.get(type),
    eventByName: (name) => eventsByName.get(name),
    events,
  };
}
