/**
 * Drops what a previous run left behind, before this one starts.
 *
 * Cases drop their own schema, so this only ever finds the litter of a run that
 * was killed. Sweeping at setup rather than teardown is deliberate: a schema a
 * failing run left is the evidence, and it stays until the next run needs the
 * database clean.
 */

import {
  postgresTestUrl,
  TEST_SCHEMA_PREFIX,
  withAdminClient,
} from "#src/backend/persistence/postgres-test-database";

export async function setup(): Promise<void> {
  if (!postgresTestUrl()) {
    return;
  }

  await withAdminClient(async (client) => {
    const stale = await client<{ nspname: string }[]>`
      select nspname from pg_namespace
      where nspname like ${`${TEST_SCHEMA_PREFIX}%`}
    `;

    await Promise.all(
      stale.map((schema) =>
        client.unsafe(`drop schema if exists "${schema.nspname}" cascade`)
      )
    );
  });
}
