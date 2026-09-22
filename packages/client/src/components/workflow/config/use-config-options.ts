/**
 * What one provider-backed config field is filled with, and why it cannot be.
 *
 * The states are kept apart on purpose. `unavailable` is the provider's own
 * verdict, arriving as a successful response; `failed` is ours. Only the first
 * can carry `not_permitted`, which is the one a builder fixes by reconnecting
 * rather than by retrying.
 */

import { useQuery } from "@tanstack/react-query";
import type { ConfigOptionsAnswer } from "#src/lib/rpc-client";
import {
  canQueryConfigOptions,
  type ConfigOptionsOwner,
  providerConfigOptionsQueryOptions,
} from "#src/lib/config-options-query";
import { readProviderParameters } from "#src/lib/provider-parameters";
import type { FieldOptionsSource } from "@wfgraph/shared/plugins/action-fields";

export type ConfigOptionsState =
  /** Nothing to ask yet: no connection, or a parameter still to fill in. */
  | { state: "waiting" }
  | { state: "loading" }
  | { state: "ready"; answer: ConfigOptionsAnswer }
  /**
   * The provider's own verdict, arriving as a successful response. Its message
   * was written by the integration, which is why it is shown; ours is not.
   */
  | {
      state: "unavailable";
      reason: "not_permitted" | "unreachable" | "refused";
      message: string;
    }
  /**
   * The request itself failed. No message travels with it: the only string
   * available is whatever the vendor's own exception carried, which nobody
   * audited and which can hold a URL with a credential in it.
   */
  | { state: "failed"; retry: () => void };

export function useConfigOptions(input: {
  owner: ConfigOptionsOwner;
  source: FieldOptionsSource | undefined;
  config: Record<string, unknown>;
}): ConfigOptionsState {
  const { owner, source, config } = input;
  const { parameters, missing } = readProviderParameters(source, config);
  const hasQuestion = source !== undefined && missing.length === 0;
  const enabled =
    hasQuestion &&
    (owner.kind === "action" || owner.integrationId !== undefined) &&
    canQueryConfigOptions(owner);
  const query = useQuery({
    ...providerConfigOptionsQueryOptions({
      owner,
      provider: source?.provider ?? "",
      parameters,
    }),
    enabled,
  });

  if (!enabled) {
    return { state: "waiting" };
  }
  if (query.isPending) {
    return { state: "loading" };
  }
  if (query.error) {
    return { state: "failed", retry: () => void query.refetch() };
  }
  if (!query.data) {
    return { state: "loading" };
  }
  if (query.data.status === "unavailable") {
    return {
      state: "unavailable",
      reason: query.data.reason,
      message: query.data.message,
    };
  }
  return { state: "ready", answer: query.data };
}
