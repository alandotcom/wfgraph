/**
 * What "Test connection" is, as an integration author writes it.
 *
 * `@rova/core/plugin` publishes these, because a test is written in the
 * integration package and run by the credentials dialog: the answer below is what
 * reaches an operator filling in the form.
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
