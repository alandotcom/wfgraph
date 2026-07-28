/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 */

export { fetchCredentials } from "#src/backend/lib/credential-fetcher";
export { registerStepImporter } from "#src/backend/lib/step-registry";
export {
  type StepInput,
  withStepLogging,
} from "#src/backend/lib/steps/step-handler";
export { registerIntegrationTest } from "#src/backend/services/integrations/integration-test-loaders";
