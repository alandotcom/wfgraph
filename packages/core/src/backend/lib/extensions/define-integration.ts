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
import type { CredentialFieldMetadata } from "@rova/shared/extensions/catalog";

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
   * `string` is a closed union while a global map is keyed by one, so a
   * type outside it fails to compile here rather than reaching an editor that
   * quietly drops the integration. B4 deletes the union and this widens to a
   * string.
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
