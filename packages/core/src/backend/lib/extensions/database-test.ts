/**
 * What "Test connection" runs for a database connection.
 *
 * Its own module because the database integration reaches it the way a plugin
 * reaches its vendor test: through a loader, so the probe below is compiled but
 * not run until someone presses the button.
 */

import postgres from "postgres";
import type { IntegrationTestResult } from "#src/backend/lib/extensions/integration-test";

/**
 * Probe a Postgres URL by opening a connection and closing it again.
 *
 * The connection has to be closed on every path, which `try/finally` states in
 * one place. A failed probe is a result rather than a throw, because "wrong
 * password" is an answer the credentials form shows rather than a fault.
 */
export async function testDatabaseConnection(
  credentials: Record<string, string>
): Promise<IntegrationTestResult> {
  const databaseUrl = credentials.DATABASE_URL;

  if (!databaseUrl) {
    return { success: false, error: "Database URL is required" };
  }

  const connection = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });

  try {
    await connection`SELECT 1`;
    return { success: true };
  } catch {
    // The vendor's own message is not passed on: a Postgres connection error
    // carries the host and port it tried, and this answer is rendered in a form
    // an operator reached over the network.
    return { success: false, error: "Connection failed" };
  } finally {
    await connection.end();
  }
}
