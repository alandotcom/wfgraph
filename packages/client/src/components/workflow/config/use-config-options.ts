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
import { configOptionsQueryOptions } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import {
  readProviderParameters,
  settledProviderParameter,
} from "#src/lib/provider-parameters";
import type { FieldOptionsSource } from "@wfgraph/shared/plugins/action-fields";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

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
  source: FieldOptionsSource | undefined;
  config: Record<string, unknown>;
}): ConfigOptionsState {
  const { source, config } = input;
  const integrationId = settledProviderParameter(config.integrationId);
  const { parameters, missing } = readProviderParameters(source, config);

  const enabled =
    source !== undefined &&
    integrationId !== undefined &&
    missing.length === 0 &&
    can(WfGraphOperations.integrationConfigOptions.id);

  const query = useQuery({
    ...configOptionsQueryOptions({
      // The query is disabled without these, so the placeholders are never sent.
      integrationId: integrationId ?? "",
      provider: source?.provider ?? "",
      parameters,
    }),
    enabled,
  });

  if (!source || integrationId === undefined || missing.length > 0) {
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
