/**
 * The stored configuration of one connection.
 *
 * Which keys it holds is the integration's own declaration: each credential field
 * names the config key its value is stored under, and the assembled catalog is
 * where a reader asks. So this is an open record of strings and nothing more.
 * Naming this repo's own keys here would be a second list of them, kept in step
 * with six definitions by hand.
 */
export type IntegrationConfig = Record<string, string | undefined>;

/** The durable lifecycle of an OAuth connection's token refresh. */
export const INTEGRATION_REFRESH_STATES = [
  "idle",
  "refreshing",
  "reauthorization_required",
] as const;

export type IntegrationRefreshState =
  (typeof INTEGRATION_REFRESH_STATES)[number];

const integrationRefreshStateSet = new Set<string>(INTEGRATION_REFRESH_STATES);

export function isIntegrationRefreshState(
  value: unknown
): value is IntegrationRefreshState {
  return typeof value === "string" && integrationRefreshStateSet.has(value);
}

/** Private encrypted-envelope member that only core's OAuth service may write. */
export const OAUTH_GRANT_CONFIG_KEY = "__wfgraph_oauth_grant_v1";
