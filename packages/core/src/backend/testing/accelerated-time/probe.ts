import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import postgres from "postgres";
import { Schema } from "effect";

// This fixture tests clock mechanics with the real SDK, engine, and database.
// It deliberately does not claim conformance of the Workflow Graph application.
const sql = postgres(
  "postgresql://workflow:workflow@127.0.0.1:5432/workflow_builder",
  {
    max: 2,
  }
);
const inngestUrl = "http://127.0.0.1:8288";
const client = new Inngest({
  id: "clock-probe",
  isDev: true,
  baseUrl: inngestUrl,
});

function emit(phase: string, data: object = {}) {
  process.stdout.write(
    `CLOCK_PROBE_EVENT ${JSON.stringify({ phase, nodeMs: Date.now(), ...data })}\n`
  );
}

async function sample() {
  const nodeBeforeMs = Date.now();
  const [row] = await sql<{ dbMs: number }[]>`
    select extract(epoch from clock_timestamp())::double precision * 1000 as "dbMs"
  `;
  const nodeAfterMs = Date.now();
  assert.ok(row);
  // Network/query latency brackets the DB reading without assuming instant I/O.
  assert.ok(
    row.dbMs >= nodeBeforeMs - 20 && row.dbMs <= nodeAfterMs + 20,
    `Database clock outside Node observation interval: ${JSON.stringify({ nodeBeforeMs, nodeAfterMs, dbMs: row.dbMs })}`
  );
  return {
    nodeBeforeMs,
    nodeAfterMs,
    dbMs: row.dbMs,
    monotonicMs: Number(process.hrtime.bigint() / BigInt(1_000_000)),
  };
}

async function until(label: string, ready: () => Promise<boolean>) {
  const deadline = Date.now() + 120_000;
  // Each poll depends on completion of the previous observation.
  // eslint-disable-next-line no-await-in-loop
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`Guest timeout: ${label}`);
    // Each observation depends on the previous result.
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
}

async function record(label: string) {
  const observation = await sample();
  await sql`insert into clock_observations (label, observation) values (${label}, ${sql.json(observation)})`;
  emit(label, observation);
  return observation;
}

const sleepFunction = client.createFunction(
  { id: "durable-sleep", triggers: [{ event: "clock/sleep" }] },
  async ({ step }) => {
    await step.run("before", () => record("sleep-before"));
    await step.sleep("five-seconds", "5s");
    await step.run("after", () => record("sleep-after"));
    return { completed: true };
  }
);

const retryFunction = client.createFunction(
  { id: "durable-retry", retries: 2, triggers: [{ event: "clock/retry" }] },
  async ({ step }) => {
    await step.run("retry-once", async () => {
      await record("retry-attempt");
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from clock_observations where label = 'retry-attempt'
      `;
      if (count === 1) throw new Error("Intentional first-attempt failure");
      return { completed: true };
    });
    return { completed: true };
  }
);

// Inngest 1.44.0's queue item lease is 30 seconds. This callback must remain
// owned through renewal, without executing its side effects a second time.
const leaseFunction = client.createFunction(
  { id: "lease-renewal", triggers: [{ event: "clock/lease" }] },
  async ({ step }) => {
    await step.run("hold-beyond-lease", async () => {
      await record("lease-before");
      await delay(35_000);
      await record("lease-after");
      return { completed: true };
    });
    return { completed: true };
  }
);

const server = createServer(
  serve({ client, functions: [sleepFunction, retryFunction, leaseFunction] })
);
let engine: ReturnType<typeof spawn> | undefined;

try {
  await sql`create table clock_observations (id serial primary key, label text not null, observation jsonb not null, created_at timestamptz default now())`;
  emit("primitive-start", await sample());
  const before = await sample();
  await delay(5000);
  const after = await sample();
  assert.ok(after.monotonicMs - before.monotonicMs >= 4900);
  assert.ok(after.dbMs - before.dbMs >= 4900);
  emit("primitive-end", { before, after });

  await sql.begin(async (transaction) => {
    const [start] = await transaction<
      { fixed: string; moving: string }[]
    >`select now()::text as fixed, clock_timestamp()::text as moving`;
    await transaction`select pg_sleep(1)`;
    const [end] = await transaction<
      { fixed: string; moving: string }[]
    >`select now()::text as fixed, clock_timestamp()::text as moving`;
    assert.equal(start.fixed, end.fixed);
    assert.ok(Date.parse(end.moving) - Date.parse(start.moving) >= 900);
    emit("transaction-clock", { start, end });
  });

  await new Promise<void>((resolve) =>
    server.listen(4017, "127.0.0.1", resolve)
  );
  engine = spawn(
    process.env.INNGEST_BINARY ?? "/usr/local/bin/inngest",
    [
      "dev",
      "--no-discovery",
      "--no-poll",
      "--retry-interval",
      "1",
      "--tick",
      "50",
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, DO_NOT_TRACK: "1" },
    }
  );
  let engineError: Error | undefined;
  engine.on("error", (error) => {
    engineError = error;
  });
  await until("Inngest startup", async () => {
    if (engineError) throw engineError;
    if (engine?.exitCode !== null)
      throw new Error("Inngest exited during startup");
    try {
      return (await fetch(`${inngestUrl}/health`)).ok;
    } catch {
      return false;
    }
  });
  const registration = await fetch(`${inngestUrl}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        'mutation { createApp(input: {url: "http://127.0.0.1:4017/api/inngest"}) { id } }',
    }),
  });
  const registrationBody = await registration.text();
  assert.ok(
    registration.ok && !registrationBody.includes('"errors"'),
    registrationBody
  );
  emit("engine-ready");
  await client.send([
    { name: "clock/sleep", data: {} },
    { name: "clock/retry", data: {} },
    { name: "clock/lease", data: {} },
  ]);
  await until("sleep, retry, and long callback completed", async () => {
    const [{ sleeps, attempts, leases }] = await sql<
      { sleeps: number; attempts: number; leases: number }[]
    >`
      select count(*) filter (where label = 'sleep-after')::int as sleeps,
             count(*) filter (where label = 'retry-attempt')::int as attempts,
             count(*) filter (where label = 'lease-after')::int as leases from clock_observations
    `;
    return sleeps >= 1 && attempts >= 2 && leases >= 1;
  });
  const timings = await sql<{ label: string; nodeMs: number; dbMs: number }[]>`
    select label, (observation->>'nodeBeforeMs')::double precision as "nodeMs",
           (observation->>'dbMs')::double precision as "dbMs"
    from clock_observations order by id
  `;
  const sleepStart = timings.find((row) => row.label === "sleep-before");
  const sleepEnd = timings.find((row) => row.label === "sleep-after");
  const attempts = timings.filter((row) => row.label === "retry-attempt");
  assert.ok(sleepStart && sleepEnd);
  assert.equal(timings.filter((row) => row.label === "sleep-before").length, 1);
  assert.equal(attempts.length, 2);
  assert.ok(sleepEnd.nodeMs - sleepStart.nodeMs >= 4900);
  assert.ok(sleepEnd.dbMs - sleepStart.dbMs >= 4900);
  assert.ok(attempts[1].nodeMs - attempts[0].nodeMs >= 900);
  const leaseStart = timings.filter((row) => row.label === "lease-before");
  const leaseEnd = timings.filter((row) => row.label === "lease-after");
  assert.equal(leaseStart.length, 1);
  assert.equal(leaseEnd.length, 1);
  assert.ok(leaseEnd[0].nodeMs - leaseStart[0].nodeMs >= 34_900);

  const runList = Schema.Struct({
    data: Schema.Struct({
      runs: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({ node: Schema.Struct({ status: Schema.String }) })
        ),
      }),
    }),
  });
  await until("all durable runs completed", async () => {
    const response = await fetch(`${inngestUrl}/v0/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          'query { runs(first: 100, orderBy: [{field: QUEUED_AT, direction: DESC}], filter: {from: "2020-01-01T00:00:00Z"}) { edges { node { status } } } }',
      }),
    });
    const body: unknown = await response.json();
    const statuses = Schema.decodeUnknownSync(runList)(
      body
    ).data.runs.edges.map((edge) => edge.node.status);
    assert.ok(
      !statuses.includes("FAILED"),
      `Durable run failed: ${statuses.join(", ")}`
    );
    return (
      statuses.length === 3 &&
      statuses.every((status) => status === "COMPLETED")
    );
  });
  const observations = await sql`select * from clock_observations order by id`;
  emit("complete", { observations, finalClock: await sample() });
} catch (error) {
  emit("failed", { error: String(error) });
  process.exitCode = 1;
} finally {
  if (engine && engine.exitCode === null) {
    const stopped = new Promise<void>((resolve) =>
      engine?.once("exit", () => resolve())
    );
    engine.kill("SIGTERM");
    const kill = setTimeout(() => engine?.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(kill);
  }
  server.closeAllConnections();
  server.close();
  await sql.end();
}
