/**
 * What a host action's provider-backed field is filled with.
 *
 * The action id selects application code retained by extension assembly. No
 * Connection or credential lookup belongs here. The field declaration is the
 * allowlist for sibling config values the provider receives.
 */

import { Effect, Result, Schema } from "effect";
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
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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
        const answerFn = await entry.load();
        const loaded = await answerFn({ parameters: accepted });
        return loaded.status === "fields"
          ? { ...loaded, fields: loaded.fields.map(omitUndefined) }
          : loaded;
      },
      catch: internalFailure,
    });
    const decoded = decodeAnswer(answer);

    if (Result.isFailure(decoded)) {
      return yield* internalFailure();
    }
    if (
      decoded.success.status !== "unavailable" &&
      decoded.success.status !== entry.answers
    ) {
      return yield* internalFailure();
    }

    return decoded.success satisfies ConfigOptionsAnswer;
  }
);
