/**
 * What a host action's provider-backed field is filled with.
 *
 * The action id selects application code retained by extension assembly. No
 * Connection or credential lookup belongs here. Generated field metadata is
 * the allowlist for schema config values the callback receives.
 */

import { Effect, Result, Schema } from "effect";
import { pickBy } from "es-toolkit/object";
import {
  acceptedConfigOptionsParameters,
  type ConfigOptionsAnswer,
} from "#src/backend/extensions/config-options";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { configOptionsAnswerSchema } from "@wfgraph/shared/rpc/contracts/config-options";
import {
  findAction,
  type ActionMetadata,
} from "@wfgraph/shared/extensions/catalog";
import { rejectUnknownKeys } from "@wfgraph/shared/types/schema";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { isBlank } from "@wfgraph/shared/types/string";

const decodeAnswer = Schema.decodeUnknownResult(configOptionsAnswerSchema(), {
  ...rejectUnknownKeys,
  errors: "all",
});

function actionFields(
  action: ActionMetadata,
  provider: string,
  parameters: Readonly<Record<string, string>>
): Record<string, string> {
  return acceptedConfigOptionsParameters({
    fields: action.configFields,
    provider,
    parameters,
  });
}

function literalDraftValues(
  parameters: Readonly<Record<string, string>>
): Readonly<Record<string, string | undefined>> {
  return pickBy(
    parameters,
    (value) => !isBlank(value) && findTemplateTokens(value).length === 0
  );
}

function internalFailure(): InternalFailure {
  return new InternalFailure({
    error: "Failed to read action config options",
  });
}

/** Ask one host action provider, validating its answer before transport. */
export const postActionConfigOptions = Effect.fn("postActionConfigOptions")(
  function* (
    actionId: string,
    provider: string,
    parameters: Readonly<Record<string, string>>
  ) {
    const extensions = yield* Extensions;
    const action = findAction(extensions.catalog, actionId);

    if (!action || action.integration) {
      return yield* new InvalidInput({
        error: `Host action "${actionId}" is not available.`,
      });
    }

    const providerIsReferenced = flattenConfigFields(action.configFields).some(
      (field) => field.optionsSource?.provider === provider
    );
    const entry = providerIsReferenced
      ? extensions.actionConfigOptionsFor(actionId, provider)
      : undefined;
    if (!entry) {
      return yield* new InvalidInput({
        error: `Action "${actionId}" declares no config options provider named "${provider}".`,
      });
    }

    const accepted = actionFields(action, provider, parameters);
    const answer = yield* Effect.tryPromise({
      try: async () => {
        const loaded = await entry(literalDraftValues(accepted));
        return Array.isArray(loaded)
          ? { status: "options" as const, options: loaded }
          : loaded;
      },
      catch: internalFailure,
    });
    const decoded = decodeAnswer(answer);

    if (Result.isFailure(decoded)) {
      return yield* internalFailure();
    }
    if (decoded.success.status === "fields") {
      return yield* internalFailure();
    }

    return decoded.success satisfies ConfigOptionsAnswer;
  }
);
