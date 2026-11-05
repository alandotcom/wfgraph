// First, so `WFGRAPH_TEST_DATABASE_URL` can come from `.env.local`.
import "../load-env";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FULL_WAKE_TIMINGS,
  measureWakeTimingsOn,
  type WakeMeasurement,
} from "@wfgraph/core/backend/executor/testing/wake-timing";
import type { WorkerBackend } from "@wfgraph/core/backend/executor/worker-loop";
import { migrateWfGraphDatabase } from "@wfgraph/core/migrate";
import { wfPostgres } from "@wfgraph/core/postgres";
import { wfSqlite } from "@wfgraph/core/sqlite";
import {
  mintTestSchemaName,
  requirePostgresTestUrl,
  withAdminClient,
} from "@wfgraph/core/backend/persistence/postgres-test-database";
import type { WfGraphPersistence } from "@wfgraph/core/backend/persistence/types";
import { createIntegrationCipher } from "@wfgraph/core/backend/services/integrations/cipher";

// `pnpm run executor:timing` measures the database executor's wake timings by
// wall clock on SQLite and on PostgreSQL: sibling Waits of 2 s and 9 s, a Cancel
// Event 1 s after both of them parked, and a Wait of 3 s behind a Wait of 2 s,
// each through the real worker loop at the backend's own poll interval. It
// prints when each node acted against when it should have, and exits non-zero
// when any of them acted more than a second late, early, or not at all.
//
// The PostgreSQL half runs in a schema of its own on the server
// `WFGRAPH_TEST_DATABASE_URL` names (`docker compose up -d` serves one), which
// it drops when it is done. Its name carries the prefix the test suite's sweep
// clears, so an interrupted run leaves nothing for long.

/** How late a node may act and still count as on time. */
const LATENESS_BOUND_MS = 1_000;

const cipher = createIntegrationCipher({ key: "e".repeat(64) });

async function measureOn(
  backend: WorkerBackend,
  persistence: WfGraphPersistence
): Promise<WakeMeasurement[]> {
  const instance = await persistence.open(cipher);
  try {
    return await measureWakeTimingsOn({
      instance,
      backend,
      durations: FULL_WAKE_TIMINGS,
    });
  } finally {
    await instance.close();
  }
}

async function measureSqlite(): Promise<WakeMeasurement[]> {
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-timing-"));
  try {
    return await measureOn(
      "sqlite",
      wfSqlite({ filename: join(directory, "wfgraph.db") })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function measurePostgres(): Promise<WakeMeasurement[]> {
  const url = requirePostgresTestUrl();
  const schema = mintTestSchemaName();
  try {
    await migrateWfGraphDatabase({ url, schema });
    return await measureOn("postgres", wfPostgres({ url, schema }));
  } finally {
    await withAdminClient((client) =>
      client.unsafe(`drop schema if exists "${schema}" cascade`)
    );
  }
}

/** A wall-clock moment as the time of day, to the millisecond. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

/** One printed line, and whether the measurement missed its bound. */
function report(measured: WakeMeasurement): { line: string; missed: boolean } {
  const label = `${measured.scenario.padEnd(8)} ${measured.what.padEnd(52)}`;
  if (measured.kind === "skipped") {
    return measured.actedAt === null
      ? { line: `${label} ok: never ran`, missed: false }
      : {
          line: `${label} MISSED: ran at ${clock(measured.actedAt)}`,
          missed: true,
        };
  }
  if (measured.actedAt === null) {
    return {
      line: `${label} MISSED: target ${clock(measured.targetAt)}, never acted`,
      missed: true,
    };
  }
  const lateMs = measured.actedAt - measured.targetAt;
  const missed = !(lateMs >= 0 && lateMs <= LATENESS_BOUND_MS);
  return {
    line: `${label} target ${clock(measured.targetAt)}  acted ${clock(measured.actedAt)}  late ${String(lateMs).padStart(4)} ms${missed ? "  MISSED" : ""}`,
    missed,
  };
}

let missedAny = false;
for (const [name, measure] of [
  ["SQLite (poll 250 ms)", measureSqlite],
  ["PostgreSQL (poll 1000 ms)", measurePostgres],
] as const) {
  console.log(name);
  // eslint-disable-next-line eslint/no-await-in-loop -- one backend at a time, so neither delays the other's wakes
  for (const measured of await measure()) {
    const { line, missed } = report(measured);
    missedAny ||= missed;
    console.log(`  ${line}`);
  }
}

process.exitCode = missedAny ? 1 : 0;
