/**
 * The extension surface as JSON, sent by `GET /api/extensions`.
 *
 * That one channel is the whole of what the browser learns about the surface,
 * which is what lets a plugin hold everything it needs in one file: the browser
 * never imports that file, so nothing a plugin reaches for reaches a bundle.
 *
 * Only data fits, so an icon and a custom output renderer stay an explicit
 * browser import, keyed by integration type in `@wfgraph/plugins/ui`, and `logoUrl`
 * serves an integration that wants no more than an image.
 *
 * The lookups are pure functions over a catalog rather than methods on one, so
 * the server and the browser run one implementation over the same document.
 */

import type { ActionConfigField } from "#src/plugins/action-fields";
import type { ReferenceField } from "#src/graph/node-references";

/**
 * One Event, as the editor lists it.
 *
 * An Event carries no lifecycle role here. Which Events start a workflow and
 * which cancel it is the Workflow Builder's declaration on the Lifecycle Node,
 * per workflow, so the catalog states vocabulary and nothing else.
 */
export type EventMetadata = {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** Absent when the Event declares none; the Workflow Builder supplies one. */
  readonly correlationPath?: string;
  readonly payloadFields: readonly ReferenceField[];
};

/**
 * One action, as the editor lists and configures it.
 *
 * `outputFields` is derived from the action's output schema on the server, so
 * there is no hand-written list on either side of the wire to keep in step.
 */
export type ActionMetadata = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  /** The integration this action belongs to, absent for a host-defined one. */
  readonly integration?: string;
  readonly logoUrl?: string;
  /**
   * Whether running this action changes something outside the workflow: a
   * message sent, a record written or removed. Absent means it only reads,
   * which is what lets a Group hold it. Narrower than the replay sense of the
   * phrase; `ActionStepInput` in core separates the two.
   */
  readonly sideEffect?: boolean;
  /**
   * When true, omitted from the action picker; the handler stays registered so
   * pinned runs and existing nodes keep working.
   */
  readonly hidden?: boolean;
  readonly configFields: readonly ActionConfigField[];
  readonly outputFields: readonly ReferenceField[];
};

/**
 * One credential the integrations dialog asks an operator for, as the form draws
 * it. What the credential is called lives in the key of the record below.
 */
export type CredentialFieldMetadata = {
  readonly label: string;
  readonly type: "text" | "password" | "url";
  readonly placeholder?: string;
  readonly helpText?: string;
  readonly helpLink?: { readonly text: string; readonly url: string };
};

/**
 * An integration's credential form, keyed by the credential's name.
 *
 * One key answers both questions a credential raises: where the stored config
 * holds the value, and what a handler reads it under. The form asks in the order
 * the keys were written.
 */
export type CredentialFields = Readonly<
  Record<string, CredentialFieldMetadata>
>;

export type IntegrationMetadata = {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentialFields: CredentialFields;
  /** Whether "Test connection" has anything to call. */
  readonly hasTest: boolean;
};

export type ExtensionCatalog = {
  readonly events: readonly EventMetadata[];
  readonly actions: readonly ActionMetadata[];
  readonly integrations: readonly IntegrationMetadata[];
};

/**
 * The surface before anything has been assembled or fetched.
 *
 * A host that forgets to pass its integrations gets this and no error, which is
 * why `createWfGraphApp` logs the counts it assembled.
 */
export const emptyExtensionCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

/**
 * An action's id, from the integration it belongs to and the slug it is keyed by.
 *
 * The one place the two halves are joined, and the only place the format is
 * known. Assembly calls it, so the id exists once and an integration definition
 * never spells it out. Which integration owns an action is answered by
 * `ActionMetadata.integration` rather than by reading the id back: a host writes
 * whatever id it likes, so a slash in one proves nothing about who owns it.
 */
export function formatActionId(integration: string, slug: string): string {
  return `${integration}/${slug}`;
}

export function findEvent(
  catalog: ExtensionCatalog,
  name: string
): EventMetadata | undefined {
  return catalog.events.find((event) => event.name === name);
}

export function findAction(
  catalog: ExtensionCatalog,
  id: string
): ActionMetadata | undefined {
  return catalog.actions.find((action) => action.id === id);
}

export function findIntegration(
  catalog: ExtensionCatalog,
  type: string
): IntegrationMetadata | undefined {
  return catalog.integrations.find((integration) => integration.type === type);
}

/**
 * Actions the editor may offer when choosing a new step.
 */
export function selectableActions(
  catalog: ExtensionCatalog
): readonly ActionMetadata[] {
  return catalog.actions.filter((action) => action.hidden !== true);
}

/**
 * Selectable actions, plus a pinned hidden action when editing a node that
 * already references it.
 */
export function actionsForPicker(
  catalog: ExtensionCatalog,
  pinnedActionId?: string
): readonly ActionMetadata[] {
  const selectable = selectableActions(catalog);
  if (!pinnedActionId) {
    return selectable;
  }

  const pinned = findAction(catalog, pinnedActionId);
  if (!pinned || pinned.hidden !== true) {
    return selectable;
  }

  if (selectable.some((action) => action.id === pinnedActionId)) {
    return selectable;
  }

  return [...selectable, pinned];
}

/** Like `actionsByCategory`, but omits hidden actions unless one is pinned. */
export function actionsForPickerByCategory(
  catalog: ExtensionCatalog,
  pinnedActionId?: string
): Record<string, ActionMetadata[]> {
  return actionsByCategory({
    ...catalog,
    actions: actionsForPicker(catalog, pinnedActionId),
  });
}

/** Like `actionsByCategory`, but omits hidden actions. */
export function selectableActionsByCategory(
  catalog: ExtensionCatalog
): Record<string, ActionMetadata[]> {
  return actionsForPickerByCategory(catalog);
}

/**
 * The actions grouped for the selector, each group in catalog order.
 *
 * The record is mutable and its lists are copies, because the editor sorts and
 * filters what it is given.
 */
export function actionsByCategory(
  catalog: ExtensionCatalog
): Record<string, ActionMetadata[]> {
  const grouped: Record<string, ActionMetadata[]> = {};

  for (const action of catalog.actions) {
    const group = grouped[action.category];
    if (group) {
      group.push(action);
    } else {
      grouped[action.category] = [action];
    }
  }

  return grouped;
}

/**
 * A stored integration config, narrowed to the credentials the integration
 * declares.
 *
 * The stored row is whatever was written to it, so a key the integration no
 * longer declares is dropped here rather than handed on. An integration the
 * catalog has never heard of contributes nothing, which is what happens when a
 * stored row outlives the integration a host passed to `createWfGraphApp`.
 *
 * A blank value is left out rather than passed on as an empty string, so a
 * handler asking whether a credential is configured reads an absent key.
 */
export function credentialsFromConfig(
  integration: IntegrationMetadata | undefined,
  config: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const credentials: Record<string, string> = {};

  for (const key of Object.keys(integration?.credentialFields ?? {})) {
    const value = config[key];
    if (value) {
      credentials[key] = value;
    }
  }

  return credentials;
}
