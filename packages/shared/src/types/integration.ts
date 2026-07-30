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
