/**
 * The registry of integration connection tests.
 *
 * "Test connection" in the credentials UI makes a real call against the vendor,
 * which means vendor SDK code. This used to be a static map here naming every
 * built-in's test module, so importing @rova/core pulled all five vendor SDKs
 * into the bundle whether or not an adopter used one.
 *
 * The direction is inverted, the way `step-registry.ts` already does it for step
 * implementations: whoever owns an integration registers a loader for its test,
 * and core only knows how to look one up. `@rova/plugins/server` registers the
 * built-ins. Registration is internal for now; opening it to hosts is what lets
 * a host-defined integration offer a connection test, and that arrives with the
 * rest of the host-integration surface.
 */
import { getExtensions } from "#src/backend/lib/extensions/current";
import type {
  IntegrationTestFunction,
  IntegrationTestLoader,
} from "#src/backend/lib/extensions/integration-test";
import type { IntegrationType } from "@rova/shared/types/integration";

const integrationTestLoaders = new Map<string, IntegrationTestLoader>();

export function registerIntegrationTest(
  type: IntegrationType,
  loader: IntegrationTestLoader
): void {
  integrationTestLoaders.set(type, loader);
}

/**
 * Drop a registered test again.
 *
 * This map is process-wide, so a test that registers one has to put it back or
 * every later test file in the run sees it, the way `unregisterIntegration` does
 * for the plugin registry.
 */
export function unregisterIntegrationTest(type: IntegrationType): void {
  integrationTestLoaders.delete(type);
}

/**
 * Whether "Test connection" has anything to call, which is what the catalog says
 * about an integration. Asking without loading, since the answer is drawn in the
 * credentials dialog and running the test is a separate press.
 *
 * This answers for the map alone. An integration passed to `createRovaApp`
 * carries its own test, and `assembleExtensions` reads `hasTest` off the
 * definition rather than asking here.
 */
export function hasIntegrationTest(type: string): boolean {
  return integrationTestLoaders.has(type);
}

export async function getIntegrationTestFunction(
  type: IntegrationType
): Promise<IntegrationTestFunction | null> {
  // An integration passed to `createRovaApp` carries its test, so the assembled
  // surface is asked first. The map holds the plugins B4 has not ported, which
  // still register on import.
  const loader =
    getExtensions().connectionTestFor(type) ?? integrationTestLoaders.get(type);
  if (!loader) {
    return null;
  }

  return await loader();
}
