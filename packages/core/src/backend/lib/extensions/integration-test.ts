/**
 * What "Test connection" is, as an integration author writes it.
 *
 * These types live with the extension surface rather than with the registry that
 * still holds the built-ins' tests, because that registry goes in B4 and the
 * shape an author writes against must not go with it. `@rova/core/plugin`
 * publishes `IntegrationTestResult` for that reason.
 */

export type IntegrationTestResult = {
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type IntegrationTestFunction = (
  credentials: Record<string, string>
) => Promise<IntegrationTestResult>;

/**
 * Loading is deferred, so declaring a test costs nothing until someone runs it
 * and the vendor code behind it stays out of the process until then.
 */
export type IntegrationTestLoader = () => Promise<IntegrationTestFunction>;
