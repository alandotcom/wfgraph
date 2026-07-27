/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 */

export { fetchCredentials } from "@/backend/lib/credential-fetcher";
export { registerStepImporter } from "@/backend/lib/step-registry";
export {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
export { registerIntegrationTest } from "@/backend/services/integrations/integration-test-loaders";
