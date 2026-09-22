import { can } from "#src/lib/authorization";
import {
  actionConfigOptionsQueryOptions,
  configOptionsQueryOptions,
} from "#src/lib/rpc-query";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/** Which server-side adapter answers one provider-backed field. */
export type ConfigOptionsOwner =
  | { readonly kind: "action"; readonly actionId: string }
  | {
      readonly kind: "integration";
      readonly integrationId: string | undefined;
    };

export type ConfigOptionsQuestion = {
  readonly owner: ConfigOptionsOwner;
  readonly provider: string;
  readonly parameters: Record<string, string>;
};

/** Whether the current actor can ask this owner for configuration data. */
export function canQueryConfigOptions(owner: ConfigOptionsOwner): boolean {
  return owner.kind === "action"
    ? can(WfGraphOperations.actionConfigOptions.id)
    : can(WfGraphOperations.integrationConfigOptions.id);
}

/** Route one provider question to its action-owned or Connection-owned cache. */
export function providerConfigOptionsQueryOptions(
  question: ConfigOptionsQuestion
) {
  return question.owner.kind === "action"
    ? actionConfigOptionsQueryOptions({
        actionId: question.owner.actionId,
        provider: question.provider,
        parameters: question.parameters,
      })
    : configOptionsQueryOptions({
        // Callers disable this question until its Connection is known.
        integrationId: question.owner.integrationId ?? "",
        provider: question.provider,
        parameters: question.parameters,
      });
}
