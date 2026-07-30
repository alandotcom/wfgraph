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

import type { IntegrationTestLoader } from "#src/backend/lib/extensions/integration-test";
import type { ActionStep } from "#src/backend/lib/steps/define-step";
import {
  type CredentialFieldMetadata,
  formatActionId,
} from "@rova/shared/extensions/catalog";
import { flattenConfigFields } from "@rova/shared/plugins/action-fields";
import type { ReferenceField } from "@rova/shared/workflow/node-references";
import {
  requireOutputFieldsFromSchema,
  requiredKeysFromSchema,
} from "@rova/shared/workflow/output-fields";

/**
 * An integration's credential form, with each `envVar` kept as a literal type.
 *
 * A plain array literal widens every `envVar` to `string`, which would leave
 * `CredentialsOf` describing an open record and a handler free to misspell a key.
 * This is a `const` type parameter and an identity function: it exists for that
 * inference and does nothing at run time.
 */
export function credentialFields<
  const TFields extends readonly CredentialFieldMetadata[],
>(fields: TFields): TFields {
  return fields;
}

/**
 * The credential keys a handler of this integration may read.
 *
 * Every value is optional because an operator may have filled in part of the
 * form: a handler decides what it can do without, and says so in the message it
 * fails with.
 */
export type CredentialsOf<TFields extends readonly CredentialFieldMetadata[]> =
  Partial<Record<Extract<TFields[number]["envVar"], string>, string>>;

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
  readonly credentials: readonly CredentialFieldMetadata[];
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
  readonly credentials: readonly CredentialFieldMetadata[];
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
    assertRequiredKeysHaveFields(id, step);

    return { id, step, outputFields };
  });
}
