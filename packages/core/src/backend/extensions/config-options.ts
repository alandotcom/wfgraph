/**
 * What a config field asks its connection, as an integration author writes it.
 *
 * A field the catalog cannot describe on its own -- a picker over the account's
 * own resources, or one input per variable a chosen resource declares -- names a
 * provider here instead. The editor asks over one RPC, core resolves the
 * connection's credentials, and this function is what answers. Credentials never
 * leave the server; only the answer below does.
 */

/** One dropdown entry, for a provider that `answers: "options"`. */
export type ConfigOptionChoice = {
  readonly value: string;
  readonly label: string;
};

/**
 * One input to draw, for a provider that `answers: "fields"`.
 *
 * `key` is the key inside the field's stored JSON object, not a config key of
 * its own: the whole set is written under the one config key that declared the
 * provider. `defaultValue` prefills the input and is not itself stored, so an
 * input left alone stays absent and the provider applies its own default.
 */
export type ConfigOptionField = {
  readonly key: string;
  readonly label: string;
  readonly defaultValue?: string;
  readonly description?: string;
  readonly type?: "string" | "number";
};

/**
 * Why a provider could not answer, in the vocabulary the editor draws.
 *
 * `not_permitted` is the one the builder can act on: the connection's grant
 * cannot read this, so reconnecting with more access is the fix and retrying is
 * not. The other two are worth a retry.
 */
export type ConfigOptionsUnavailableReason =
  | "not_permitted"
  | "unreachable"
  | "refused";

/**
 * A refusal is an answer, not a failure. The connection test makes the same
 * decision: a provider saying no is information the builder needs, and raising
 * it as a server error would lose the sentence the provider wrote.
 */
export type ConfigOptionsAnswer =
  | {
      readonly status: "options";
      readonly options: readonly ConfigOptionChoice[];
    }
  | { readonly status: "fields"; readonly fields: readonly ConfigOptionField[] }
  | {
      readonly status: "unavailable";
      readonly reason: ConfigOptionsUnavailableReason;
      readonly message: string;
    };

/** The sibling config values the field's `optionsSource` named, already read. */
export type ConfigOptionsRequest = {
  readonly parameters: Readonly<Record<string, string>>;
};

/**
 * `TCredentials` is the integration's own vocabulary, so a provider reads the
 * same keys its handlers do, for the reason `IntegrationTestFunction` gives.
 */
export type ConfigOptionsFunction<
  TCredentials = Record<string, string | undefined>,
> = (
  credentials: TCredentials,
  request: ConfigOptionsRequest
) => Promise<ConfigOptionsAnswer>;

/** Deferred for the reason `IntegrationTestLoader` is deferred. */
export type ConfigOptionsLoader<
  TCredentials = Record<string, string | undefined>,
> = () => Promise<ConfigOptionsFunction<TCredentials>>;

/**
 * `answers` is what makes a field's wiring checkable before anyone opens the
 * panel: a `provider-select` needs options and a `provider-fields` needs fields,
 * and `checkIntegration` refuses the pairing that cannot draw.
 */
export type ConfigOptionsProvider<
  TCredentials = Record<string, string | undefined>,
> = {
  readonly answers: "options" | "fields";
  readonly load: ConfigOptionsLoader<TCredentials>;
};
