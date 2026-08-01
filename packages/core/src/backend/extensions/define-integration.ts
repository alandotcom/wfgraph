/**
 * An integration as one value: its credentials, its actions, and the connection
 * test behind them.
 *
 * Nothing registers on import. A host hands the value to `createRovaApp` under
 * `extensions.integrations`, so the line that turns an integration on is a line
 * in the host's code rather than a consequence of what happens to be installed.
 *
 * The record key is the action slug, and it is the only place the slug exists:
 * the action id `${type}/${slug}` is computed at assembly, so it is never
 * written twice and never written differently in two places. `defineStep` holds
 * everything else an action needs, which is why nothing here mentions a handler.
 */

import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";
import type { ActionStep } from "#src/backend/extensions/steps/define-step";
import {
  type CredentialFields,
  formatActionId,
} from "@rova/shared/extensions/catalog";
import type { ReferenceField } from "@rova/shared/graph/node-references";
import { requireOutputFieldsFromSchema } from "@rova/shared/graph/output-fields";

/**
 * The credential keys a handler of this integration may read.
 *
 * The keys come off the record the integration declared, so a handler naming one
 * it never declared fails to compile. Every value is optional because an operator
 * may have filled in part of the form: a handler decides what it can do without,
 * and says so in the message it fails with.
 */
export type CredentialsOf<TFields extends CredentialFields> = Partial<
  Record<Extract<keyof TFields, string>, string>
>;

export type IntegrationDefinition = {
  readonly kind: "integration";
  /**
   * Keys the stored credentials, and prefixes every action id.
   *
   * Any string: the set of types a server holds is whatever was passed to
   * `createRovaApp`, and the assembled catalog is what a reader asks.
   */
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentials: CredentialFields;
  /**
   * What "Test connection" calls, absent when the integration offers none.
   *
   * A loader rather than a function: a connection test reaches the vendor over
   * the network, so it stays behind a dynamic import until someone presses the
   * button.
   */
  readonly test?: IntegrationTestLoader;
  /** Keyed by action slug. */
  readonly actions: Readonly<Record<string, ActionStep>>;
};

export function defineIntegration(input: {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentials: CredentialFields;
  readonly test?: IntegrationTestLoader;
  readonly actions: Readonly<Record<string, ActionStep>>;
}): IntegrationDefinition {
  return { kind: "integration", ...input };
}

/** One action of an integration, named and with its field list derived. */
export type CheckedAction = {
  /** `${integration.type}/${slug}`, which is where the id first exists. */
  readonly id: string;
  readonly step: ActionStep;
  /** What the editor offers downstream nodes, read from the output schema. */
  readonly outputFields: readonly ReferenceField[];
};

/**
 * Hold an integration's actions to what the editor and the engine need of them,
 * naming the offender.
 *
 * Assembly calls this for every integration a host passes, so a bad definition
 * fails the app that turned it on. It is exported for the package that wrote the
 * definition to call in its own suite: a host meeting the throw at startup is the
 * right place for a host and the wrong place for the author, where a missing
 * annotation would otherwise pass review as a green run.
 */
export function checkIntegration(
  integration: IntegrationDefinition
): readonly CheckedAction[] {
  return Object.entries(integration.actions).map(([slug, step]) => {
    const id = formatActionId(integration.type, slug);

    const outputFields = requireOutputFieldsFromSchema(
      `Action "${id}"`,
      step.output
    );

    return { id, step, outputFields };
  });
}
