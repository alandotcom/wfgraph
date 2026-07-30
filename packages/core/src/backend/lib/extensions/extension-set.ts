/**
 * The whole extension surface, assembled once.
 *
 * Nothing registers itself: the host hands its definitions to `createRovaApp`,
 * which calls this. What comes back has a catalog, which is JSON and crosses the
 * wire, beside the lookups the server keeps.
 *
 * Assembly holds each identifier to one owner, throwing named so the failure
 * lands in the build of whoever wrote the definition rather than in an editor
 * listing the wrong thing. It is also where an integration's actions get their
 * ids and their derived field lists, because the id is `${type}/${slug}` and the
 * slug is a record key the definition never spells out twice.
 */

import { flattenConfigFields } from "@rova/shared/plugins/action-fields";
import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
  IntegrationMetadata,
} from "@rova/shared/extensions/catalog";
import {
  requireOutputFieldsFromSchema,
  requiredKeysFromSchema,
} from "@rova/shared/workflow/output-fields";
import type { StepFunction } from "@rova/shared/workflow/step-result";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";
import type { AnyEventDefinition } from "#src/backend/lib/extensions/define-event";
import type { IntegrationDefinition } from "#src/backend/lib/extensions/define-integration";
import type { ActionStep } from "#src/backend/lib/steps/define-step";
import type { IntegrationTestLoader } from "#src/backend/lib/extensions/integration-test";

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
 * An integration arrives as a definition, so its actions bring their step
 * implementations with them and this set can answer for both halves. `actions` is
 * a host's own, which carry their implementation in the runtime action registry
 * `createRovaApp` fills; they reach this as metadata because that is all the
 * catalog wants from them.
 */
export type RovaExtensions = {
  readonly events?: readonly AnyEventDefinition[];
  readonly integrations?: readonly IntegrationDefinition[];
  readonly actions?: readonly ActionMetadata[];
};

export type ExtensionSet = {
  /** The serializable half. This is what /api/extensions sends. */
  readonly catalog: ExtensionCatalog;
  /** Server-only, keyed by the same action ids the catalog carries. */
  readonly stepFor: (actionId: string) => StepFunction | undefined;
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

/**
 * Every key an action's config form insists on a value for, groups flattened.
 *
 * A group is a rendering decision, so a field inside one fills its key the same
 * as a field beside it.
 */
function requiredFieldKeys(step: ActionStep): Set<string> {
  return new Set(
    flattenConfigFields(step.configFields)
      .filter((field) => field.required === true)
      .map((field) => field.key)
  );
}

/**
 * A key the step cannot run without needs a field a builder has to fill in.
 *
 * The compiler already holds each declared field to a key the schema names; this
 * is the other half. A field that is merely present is not enough: one a builder
 * may leave blank produces the config with the key missing, which is the
 * every-run decode failure this check exists to prevent.
 */
function assertRequiredKeysHaveFields(
  actionId: string,
  step: ActionStep
): void {
  const required = requiredFieldKeys(step);
  const missing = requiredKeysFromSchema(step.input).filter(
    (key) => !required.has(key)
  );

  if (missing.length > 0) {
    throw new Error(
      `Action "${actionId}" cannot run without the config keys ${missing.join(", ")}, and declares no field marked required for them, so a builder could save a node that fails on every run. Mark a field for each \`required: true\`, or make the key optional in the input schema.`
    );
  }
}

/**
 * An integration's actions, as the catalog lists them and as the engine runs them.
 *
 * This is where the action id exists: nothing before it holds both the
 * integration's type and the slug, which is why the derived field list and both
 * checks over an action's schemas happen here rather than at definition.
 */
function readIntegration(
  integration: IntegrationDefinition,
  into: {
    actions: ActionMetadata[];
    steps: Map<string, StepFunction>;
    tests: Map<string, IntegrationTestLoader>;
  }
): IntegrationMetadata {
  for (const [slug, step] of Object.entries(integration.actions)) {
    const id = `${integration.type}/${slug}`;

    const outputFields = requireOutputFieldsFromSchema(
      `Action "${id}"`,
      step.output
    );
    assertRequiredKeysHaveFields(id, step);

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

export function assembleExtensions(input: RovaExtensions): ExtensionSet {
  const eventsByName = indexEvents(input.events ?? []);
  const events = Array.from(eventsByName.values());
  assertSourcesAreDistinguishable(events);
  assertDistinctListenerIds(events);

  const steps = new Map<string, StepFunction>();
  const tests = new Map<string, IntegrationTestLoader>();
  const definedActions: ActionMetadata[] = [];
  const definedIntegrations = (input.integrations ?? []).map((integration) =>
    readIntegration(integration, { actions: definedActions, steps, tests })
  );

  // The built-ins go in first, so a host action colliding with one of them is
  // caught by the same check as any other collision.
  const actions = [
    ...builtInActions,
    ...definedActions,
    ...(input.actions ?? []),
  ];
  assertDistinctActionIds(actions);

  assertDistinctIntegrationTypes(definedIntegrations);

  return {
    catalog: {
      events: events.map(toEventMetadata),
      actions,
      integrations: definedIntegrations,
    },
    stepFor: (actionId) => steps.get(actionId),
    connectionTestFor: (type) => tests.get(type),
    eventByName: (name) => eventsByName.get(name),
    events,
  };
}
