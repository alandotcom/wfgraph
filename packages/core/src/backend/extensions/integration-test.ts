/**
 * What "Test connection" is, as an integration author writes it.
 *
 * `@wfgraph/core/plugin` publishes these, because a test is written in the
 * integration package and run by the credentials dialog: the answer below is what
 * reaches an operator filling in the form.
 */

/**
 * A discriminated union, so a failure always carries its sentence and a success
 * cannot carry one. `details` is whatever the vendor said, for the log line only.
 */
export type IntegrationTestResult =
  | { success: true; details?: Record<string, unknown> }
  | { success: false; error: string; details?: Record<string, unknown> };

/**
 * Where each credential came from, which the values themselves do not say.
 *
 * A provider issues an OAuth credential with the scopes the grant asked for, so
 * the same refusal that condemns a hand-entered key can be the proof an
 * OAuth-issued one is valid. `oauthCredentialKeys` is empty for a form the
 * operator is still filling in, since nothing has been granted yet.
 */
export type IntegrationTestContext = {
  readonly oauthCredentialKeys: readonly string[];
};

/**
 * `TCredentials` is the integration's own vocabulary, so a test reads the same
 * keys its handlers do. The default is the open record, for a caller holding an
 * integration whose vocabulary it does not know. Its values are optional because
 * an operator may have filled in part of the form, which is the same reason
 * `CredentialsOf` describes a partial record.
 */
export type IntegrationTestFunction<
  TCredentials = Record<string, string | undefined>,
> = (
  credentials: TCredentials,
  context: IntegrationTestContext
) => Promise<IntegrationTestResult>;

/**
 * Loading is deferred, so declaring a test costs nothing until someone runs it
 * and the vendor code behind it stays out of the process until then.
 */
export type IntegrationTestLoader<
  TCredentials = Record<string, string | undefined>,
> = () => Promise<IntegrationTestFunction<TCredentials>>;
