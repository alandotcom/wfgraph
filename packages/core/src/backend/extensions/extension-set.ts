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
  PROVIDER_FIELD_TYPES,
} from "@wfgraph/shared/plugins/action-fields";
import type { StepFactory } from "#src/backend/extensions/steps/step-runner";
import { builtInActions } from "#src/backend/extensions/built-ins";
import type { ActionDefinition } from "#src/backend/extensions/define-action";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import {
  assertDistinctListenerIds,
  assertSourcesAreDistinguishable,
} from "#src/backend/extensions/event-uniqueness";
import {
  checkIntegration,
  type IntegrationDefinition,
} from "#src/backend/extensions/define-integration";
import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";
import type { IntegrationOAuth } from "#src/backend/extensions/oauth";
import type { ConfigOptionsProvider } from "#src/backend/extensions/config-options";
import type { IntegrationWebhook } from "#src/backend/extensions/integration-webhook";
import {
  isSafeRecordKey,
  isSafeRecordPath,
} from "@wfgraph/shared/types/record-key";
import type { ReferenceField } from "@wfgraph/shared/graph/node-references";
import { CONNECTION_STAMP_KEY } from "#src/backend/lib/inngest/catalog-connection";

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
  readonly events?: readonly AnyEventDefinition[] | undefined;
  readonly integrations?: readonly IntegrationDefinition[] | undefined;
  readonly actions?: readonly ActionDefinition[] | undefined;
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
  /**
   * What a provider-backed config field asks, keyed by integration type and the
   * name its `optionsSource` used. Server-only, like `connectionTestFor`: the
   * catalog carries the field's `optionsSource` and nothing behind it.
   */
  readonly configOptionsFor: (
    type: string,
    provider: string
  ) => ConfigOptionsProvider | undefined;
  /** Provider behavior for OAuth routes; none of this map crosses the catalog. */
  readonly oauthFor: (type: string) => IntegrationOAuth | undefined;
  /**
   * The webhook an integration declared, if any. Server-only: verify and receive
   * stay off the catalog, which is what the editor reads.
   */
  readonly webhookFor: (type: string) => IntegrationWebhook | undefined;
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

/**
 * The field types the editor draws with a template picker.
 *
 * The two provider-backed types are here because each falls back to a template
 * control -- when no connection is chosen, when the provider refuses, or when
 * the value is already a `{{...}}` reference -- so each can offer the picker.
 */
const TEMPLATE_FIELD_TYPES = new Set<ActionConfigFieldBase["type"]>([
  "template-input",
  "template-textarea",
  ...PROVIDER_FIELD_TYPES,
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

function assertSafeConfigFieldKeys(action: ActionMetadata): void {
  for (const field of flattenConfigFields(action.configFields)) {
    if (!isSafeRecordKey(field.key)) {
      throw new Error(
        `Action "${action.id}" declares a config field with a key reserved by JavaScript objects.`
      );
    }
    if (field.showWhen && !isSafeRecordKey(field.showWhen.field)) {
      throw new Error(
        `Action "${action.id}" declares a conditional field reference with a key reserved by JavaScript objects.`
      );
    }
  }
}

function assertSafeReferencePaths(
  subject: string,
  fields: readonly ReferenceField[]
): void {
  if (fields.some((field) => !isSafeRecordPath(field.path))) {
    throw new Error(
      `${subject} declares a field path containing a key reserved by JavaScript objects.`
    );
  }
}

/**
 * An integration-owned Event may not declare the key the Connection stamp uses.
 *
 * `sendCatalogEvent` writes the Connection onto `data` under
 * `CONNECTION_STAMP_KEY` and the listener removes it again, so a field declared
 * there would be overwritten on the way out and missing on the way in. The
 * prefix makes that collision unlikely; this makes it loud rather than silent.
 */
function assertNoConnectionStampField(
  eventName: string,
  fields: readonly ReferenceField[]
): void {
  if (
    fields.some((field) => field.path.split(".")[0] === CONNECTION_STAMP_KEY)
  ) {
    throw new Error(
      `Event "${eventName}" declares a payload field at "${CONNECTION_STAMP_KEY}", which Workflow Graph reserves for the Connection an integration Event arrived through. Give the field another name.`
    );
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
function toEventMetadata(
  event: RegisteredEvent,
  integration?: string
): EventMetadata {
  return {
    name: event.name,
    label: event.label,
    ...(event.description ? { description: event.description } : {}),
    ...(event.correlationPath
      ? { correlationPath: event.correlationPath }
      : {}),
    ...(integration ? { integration } : {}),
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
  /** Keyed first by integration type, then by the provider it declares. */
  configOptions: Map<string, Map<string, ConfigOptionsProvider>>;
  oauth: Map<string, IntegrationOAuth>;
  webhooks: Map<string, IntegrationWebhook>;
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
      sideEffect: step.sideEffect,
      ...(step.hidden ? { hidden: true } : {}),
      configFields: step.configFields,
      outputFields,
    });
    into.steps.set(id, step.implement(id));
  }

  if (integration.test) {
    into.tests.set(integration.type, integration.test);
  }

  for (const [provider, entry] of Object.entries(
    integration.configOptions ?? {}
  )) {
    let providers = into.configOptions.get(integration.type);
    if (!providers) {
      providers = new Map();
      into.configOptions.set(integration.type, providers);
    }
    providers.set(provider, entry);
  }

  if (integration.oauth) {
    if (integration.oauth.label.trim().length === 0) {
      throw new Error(
        `Integration "${integration.type}" declares OAuth without a label.`
      );
    }
    into.oauth.set(integration.type, integration.oauth);
  }

  if (integration.webhook) {
    into.webhooks.set(integration.type, integration.webhook);
  }

  return {
    type: integration.type,
    label: integration.label,
    description: integration.description,
    credentialFields: integration.credentials,
    hasTest: integration.test !== undefined,
    hasWebhook: integration.webhook !== undefined,
    ...(integration.webhook?.helpText
      ? { webhookHelpText: integration.webhook.helpText }
      : {}),
    ...(integration.webhook?.secret
      ? { webhookSecretKey: integration.webhook.secret }
      : {}),
    ...(integration.oauth ? { oauth: { label: integration.oauth.label } } : {}),
  };
}

/**
 * A provider-backed field needs an integration behind it.
 *
 * `checkIntegration` holds an integration's own fields to a declared provider,
 * but a host's `defineAction` has no integration and no connection, so a field
 * asking one there would draw a control nothing can ever answer.
 */
function assertProviderFieldsBelongToAnIntegration(
  action: ActionMetadata
): void {
  if (action.integration) {
    return;
  }

  for (const field of flattenConfigFields(action.configFields)) {
    if (field.optionsSource || PROVIDER_FIELD_TYPES.has(field.type)) {
      throw new Error(
        `Action "${action.id}" is a host action, so its "${field.key}" field has no connection to ask. Provider-backed fields belong to an integration.`
      );
    }
  }
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
    sideEffect: action.sideEffect,
    ...(action.hidden ? { hidden: true } : {}),
    configFields: action.configFields ?? [],
    outputFields: action.outputFields ?? [],
  });
  into.steps.set(action.id, action.implement);
}

export function assembleExtensions(input: WfGraphExtensions): ExtensionSet {
  // Integration Events go in first, so a host listing the same `defineEvent`
  // object a plugin already declared is identity-equal and kept once. The owner
  // map is what stamps `EventMetadata.integration` without mutating the value.
  const eventOwners = new Map<string, string>();
  const integrationEvents: AnyEventDefinition[] = [];
  for (const integration of input.integrations ?? []) {
    for (const event of integration.events ?? []) {
      // Two integrations listing the same `defineEvent` object pass indexEvents,
      // which only refuses two definitions sharing a name. Taking the last
      // writer would leave the catalog offering one integration's Connections
      // for an Event the other's webhook also delivers, so arrivals through the
      // loser could match nothing.
      const owner = eventOwners.get(event.name);
      if (owner && owner !== integration.type) {
        throw new Error(
          `Event "${event.name}" is declared by integrations "${owner}" and "${integration.type}". An integration-owned Event belongs to one integration, because the Connection it arrives through is chosen from that integration's Connections.`
        );
      }
      integrationEvents.push(event);
      eventOwners.set(event.name, integration.type);
    }
  }

  const eventsByName = indexEvents([
    ...integrationEvents,
    ...(input.events ?? []),
  ]);
  const events = Array.from(eventsByName.values());
  for (const event of events) {
    assertSafeReferencePaths(`Event "${event.name}"`, event.payloadFields);
    if (eventOwners.has(event.name)) {
      assertNoConnectionStampField(event.name, event.payloadFields);
    }
  }
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
    configOptions: new Map(),
    oauth: new Map(),
    webhooks: new Map(),
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
    assertSafeConfigFieldKeys(action);
    assertSafeReferencePaths(`Action "${action.id}"`, action.outputFields);
    assertLiteralFieldsRenderNoTemplatePicker(action);
    assertProviderFieldsBelongToAnIntegration(action);
  }

  return {
    catalog: {
      events: events.map((event) =>
        toEventMetadata(event, eventOwners.get(event.name))
      ),
      actions: into.actions,
      integrations,
    },
    stepFor: (actionId) => into.steps.get(actionId),
    connectionTestFor: (type) => into.tests.get(type),
    configOptionsFor: (type, provider) =>
      into.configOptions.get(type)?.get(provider),
    oauthFor: (type) => into.oauth.get(type),
    webhookFor: (type) => into.webhooks.get(type),
    eventByName: (name) => eventsByName.get(name),
    events,
  };
}
