/**
 * What a provider-backed config field is filled with, asked of one connection.
 *
 * The editor holds a connection id and a provider name; this resolves that
 * connection's credentials and hands them to the integration's own code. The
 * credentials never leave the server, and the answer's wire schema names every
 * field it may carry.
 *
 * A provider refusing is a success carrying `status: "unavailable"`. Raising it
 * as a server failure would lose the sentence the provider wrote, which is the
 * one thing a builder can act on.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { resolveIntegrationCredentials } from "#src/backend/services/integrations/credential-resolver";
import {
  attemptVendorStep,
  describeUnavailableIntegration,
} from "#src/backend/services/integrations/vendor-call";
import type { ConfigOptionsAnswer } from "#src/backend/extensions/config-options";
import {
  type ExtensionCatalog,
  fieldsForIntegration,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { isSafeRecordKey } from "@wfgraph/shared/types/record-key";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

const describeConfigOptionsFailure = () =>
  "Failed to read integration config options";

export const postIntegrationConfigOptions = Effect.fn(
  "postIntegrationConfigOptions"
)(function* (
  integrationId: string,
  provider: string,
  parameters: Record<string, string>
) {
  const logger = (yield* AppLogger)
    .get("integrations")
    .with({ integrationId, provider });
  const attempt = attemptVendorStep(logger, describeConfigOptionsFailure);
  const repo = yield* IntegrationRepo;
  const extensions = yield* Extensions;

  // The row is read for its type alone, so a request naming a provider this
  // build does not declare is refused before anything is decrypted. Resolving
  // credentials first would decrypt, and on an expired grant would spend a token
  // rotation, for a request that was never going to be answered.
  const integration = yield* repo.findById(integrationId).pipe(
    Effect.catchTags({
      DatabaseError: () =>
        new InternalFailure({ error: "Failed to read config options" }),
      EncryptionKeyMismatch: () =>
        new InternalFailure({ error: "Failed to read config options" }),
    })
  );
  if (!integration) {
    return yield* new NotFound({ error: "Integration not found" });
  }

  if (!findIntegration(extensions.catalog, integration.type)) {
    const error = describeUnavailableIntegration(
      extensions.catalog,
      integration.type
    );
    yield* logger.warn(error);
    return yield* new InvalidInput({ error });
  }

  const entry = extensions.configOptionsFor(integration.type, provider);
  if (!entry) {
    // Only reachable when the editor and this server are different builds: the
    // field naming this provider came from a catalog that declared it.
    const error = `Integration "${integration.type}" declares no config options provider named "${provider}".`;
    yield* logger.warn(error);
    return yield* new InvalidInput({ error });
  }

  const accepted = acceptedParameters(
    extensions.catalog,
    integration.type,
    provider,
    parameters
  );

  const resolved = yield* resolveIntegrationCredentials(integrationId);
  const answerFn = yield* attempt(() => entry.load());
  const answer = yield* attempt(() =>
    answerFn(resolved.credentials, { parameters: accepted })
  );

  if (!answerKindMatches(entry.answers, answer)) {
    // A plugin bug rather than anything the builder did, so an operator sees it
    // as a server failure rather than the builder meeting it in the panel.
    return yield* new InternalFailure({
      error: `Config options provider "${provider}" answered "${answer.status}" where "${entry.answers}" was declared.`,
    });
  }

  if (
    answer.status === "fields" &&
    answer.fields.some((field) => !isSafeRecordKey(field.key))
  ) {
    return yield* new InternalFailure({
      error: `Config options provider "${provider}" answered with a field key reserved by JavaScript objects.`,
    });
  }

  // One record for the request. Names and labels are the account's own data, so
  // the answer's size is here and its contents are not.
  yield* logger.info("Read integration config options", {
    request: { parameterKeys: Object.keys(accepted) },
    outcome: {
      status: answer.status,
      // oxlint-disable-next-line wfgraph/no-conditional-spread -- `options` is the one status carrying a list of options to count.
      ...(answer.status === "options"
        ? { optionCount: answer.options.length }
        : {}),
      // oxlint-disable-next-line wfgraph/no-conditional-spread -- `fields` is the one status carrying a list of fields to count.
      ...(answer.status === "fields"
        ? { fieldCount: answer.fields.length }
        : {}),
      // oxlint-disable-next-line wfgraph/no-conditional-spread -- `unavailable` is the one status carrying a reason.
      ...(answer.status === "unavailable" ? { reason: answer.reason } : {}),
    },
  });

  // An author writes a field in `ConfigOptionField`, whose optional members
  // admit `undefined`; the wire shape takes an absent key for each of them. A
  // key holding `undefined` is dropped here rather than at the encoder, so the
  // two shapes agree in the type system as well as over JSON.
  return answer.status === "fields"
    ? { status: answer.status, fields: answer.fields.map(omitUndefined) }
    : answer;
});

/**
 * The parameters this provider is allowed to be asked with.
 *
 * Every value here lands in a request the connection's credentials pay for, so
 * the map is intersected against what a field actually declared rather than
 * forwarded as the browser sent it. The declaration is the allowlist; a count
 * would only be a proxy for it.
 */
function acceptedParameters(
  catalog: ExtensionCatalog,
  integrationType: string,
  provider: string,
  parameters: Record<string, string>
): Record<string, string> {
  const declared = new Set<string>();
  for (const field of fieldsForIntegration(catalog, integrationType)) {
    if (field.optionsSource?.provider === provider) {
      for (const key of field.optionsSource.parameters ?? []) {
        declared.add(key);
      }
    }
  }

  const accepted: Array<[string, string]> = [];
  for (const key of declared) {
    const value = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
    if (value !== undefined) {
      accepted.push([key, value]);
    }
  }
  return Object.fromEntries(accepted);
}

/** An `unavailable` answer is valid whatever the provider declared it answers. */
function answerKindMatches(
  declared: "options" | "fields",
  answer: ConfigOptionsAnswer
): boolean {
  return answer.status === "unavailable" || answer.status === declared;
}
