/**
 * What a config field asks application code to supply.
 *
 * A field the catalog cannot describe on its own -- a picker over available
 * resources, or one input per variable a chosen resource declares -- names a
 * provider here instead. An integration provider receives Connection
 * credentials; a host action provider receives only its declared parameters.
 * Only the answer below crosses to the editor.
 */

import {
  flattenConfigFields,
  type ActionConfigField,
  MAX_CONFIG_OPTIONS_PARAMETERS,
  PROVIDER_FIELD_TYPES,
} from "@wfgraph/shared/plugins/action-fields";
import { isSafeRecordKey } from "@wfgraph/shared/types/record-key";

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
  readonly defaultValue?: string | undefined;
  readonly description?: string | undefined;
  readonly type?: "string" | "number" | undefined;
  /**
   * Whether the provider needs a value here. A field with a `defaultValue`
   * never is, because leaving it alone is what asks for that default.
   */
  readonly required?: boolean | undefined;
};

/**
 * Why a provider could not answer, in the vocabulary the editor draws.
 *
 * `not_permitted` means the active source is not authorized to answer. For an
 * integration, reconnecting with more access can be the fix; application code
 * can provide its own recovery sentence. The other two are worth a retry.
 */
export type ConfigOptionsUnavailableReason =
  | "not_permitted"
  | "unreachable"
  | "refused";

/**
 * A refusal is an answer, not a failure. A provider saying no is information
 * the builder needs, and raising it as a server error would lose the sentence
 * the provider wrote.
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

/** What a host action's provider calls once the editor asks its question. */
export type ActionConfigOptionsFunction = (
  request: ConfigOptionsRequest
) => Promise<ConfigOptionsAnswer>;

/** Deferred so application code and its dependencies load only when asked. */
export type ActionConfigOptionsLoader =
  () => Promise<ActionConfigOptionsFunction>;

/** One application-scoped provider owned by one host action. */
export type ActionConfigOptionsProvider = {
  readonly answers: "options" | "fields";
  readonly load: ActionConfigOptionsLoader;
};

type ConfigOptionsProviderDeclaration = {
  readonly answers: "options" | "fields";
};

/**
 * Refuse declaration records that cannot safely be indexed by authored text.
 */
export function assertConfigOptionsProviders(input: {
  subject: string;
  providers:
    | Readonly<Record<string, ConfigOptionsProviderDeclaration>>
    | undefined;
}): void {
  if (!input.providers) {
    return;
  }

  if (Object.getPrototypeOf(input.providers) !== Object.prototype) {
    throw new Error(
      `${input.subject} must declare config options providers in an ordinary object record; a reserved __proto__ literal changes the record prototype instead of declaring a key.`
    );
  }

  for (const provider of Object.keys(input.providers)) {
    if (!isSafeRecordKey(provider)) {
      throw new Error(
        `${input.subject} declares a config options provider with a key reserved by JavaScript objects.`
      );
    }
  }
}

/**
 * Hold provider-backed fields to providers their owner actually declares.
 *
 * This is shared by host actions and integration actions. The two authoring
 * paths differ in how a provider runs, while the form wiring is the same.
 */
export function acceptedConfigOptionsParameters(input: {
  fields: readonly ActionConfigField[];
  provider: string;
  parameters: Readonly<Record<string, string>>;
}): Record<string, string> {
  const declared = new Set<string>();
  for (const field of flattenConfigFields(input.fields)) {
    if (field.optionsSource?.provider === input.provider) {
      for (const key of field.optionsSource.parameters ?? []) {
        declared.add(key);
      }
    }
  }

  return Object.fromEntries(
    Array.from(declared).flatMap((key): Array<[string, string]> => {
      const value = Object.hasOwn(input.parameters, key)
        ? input.parameters[key]
        : undefined;
      return value === undefined ? [] : [[key, value]];
    })
  );
}

export function assertConfigOptionsWiring(input: {
  actionId: string;
  fields: readonly ActionConfigField[];
  providers:
    | Readonly<Record<string, ConfigOptionsProviderDeclaration>>
    | undefined;
  owner: string;
  requireEveryProviderReferenced: boolean;
}): void {
  const fields = flattenConfigFields(input.fields);
  const declaredKeys = new Set(fields.map((field) => field.key));
  const referencedProviders = new Set<string>();

  for (const field of fields) {
    const where = `Action "${input.actionId}" field "${field.key}"`;
    const source = field.optionsSource;

    if (!isSafeRecordKey(field.key)) {
      throw new Error(
        `Action "${input.actionId}" declares a config field with a key reserved by JavaScript objects.`
      );
    }
    if (field.showWhen && !isSafeRecordKey(field.showWhen.field)) {
      throw new Error(
        `Action "${input.actionId}" declares a conditional field reference with a key reserved by JavaScript objects.`
      );
    }
    if (field.showWhen && !declaredKeys.has(field.showWhen.field)) {
      throw new Error(
        `${where} is conditional on "${field.showWhen.field}", which is not a config field of this action.`
      );
    }

    if (!source) {
      if (PROVIDER_FIELD_TYPES.has(field.type)) {
        throw new Error(
          `${where} is a ${field.type} field with no optionsSource, so nothing says which provider data to draw.`
        );
      }
      continue;
    }

    if (!isSafeRecordKey(source.provider)) {
      throw new Error(
        `Action "${input.actionId}" declares a config options provider with a key reserved by JavaScript objects.`
      );
    }
    referencedProviders.add(source.provider);

    if (!PROVIDER_FIELD_TYPES.has(field.type)) {
      throw new Error(
        `${where} declares an optionsSource on a "${field.type}" field, which draws no provider data.`
      );
    }

    const wants = field.type === "provider-select" ? "options" : "fields";
    const provider =
      input.providers && Object.hasOwn(input.providers, source.provider)
        ? input.providers[source.provider]
        : undefined;
    if (!provider) {
      throw new Error(
        `${where} names the config options provider "${source.provider}", which ${input.owner} does not declare.`
      );
    }
    if (provider.answers !== wants) {
      throw new Error(
        `${where} needs a provider answering "${wants}", but "${source.provider}" answers "${provider.answers}".`
      );
    }

    const parameters = source.parameters ?? [];
    if (new Set(parameters).size > MAX_CONFIG_OPTIONS_PARAMETERS) {
      throw new Error(
        `${where} declares more than ${MAX_CONFIG_OPTIONS_PARAMETERS} distinct provider parameters, which one editor request cannot carry.`
      );
    }

    for (const parameter of parameters) {
      if (!isSafeRecordKey(parameter)) {
        throw new Error(
          `Action "${input.actionId}" declares a provider parameter with a key reserved by JavaScript objects.`
        );
      }
      if (!declaredKeys.has(parameter)) {
        throw new Error(
          `${where} names the parameter "${parameter}", which is not a config field of this action.`
        );
      }
    }
  }

  if (!input.requireEveryProviderReferenced) {
    return;
  }

  for (const provider of Object.keys(input.providers ?? {})) {
    if (!referencedProviders.has(provider)) {
      throw new Error(
        `${input.owner} declares the config options provider "${provider}", but no config field references it.`
      );
    }
  }
}
