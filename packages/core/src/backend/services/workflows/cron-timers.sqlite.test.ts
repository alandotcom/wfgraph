/**
 * The workflow services that keep cron timers, run over native SQLite: Publish
 * writes a timer per schedule of the graph it publishes, and the bulk pause
 * and resume delete and rewrite them. The repository cases in
 * `persistence/conformance/execution-cron.ts` cover the rows themselves.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  type CronSchedule,
  nextFireAfter,
} from "@wfgraph/shared/lifecycle/cron-schedule";
import {
  SilentAppLoggerLayer,
  stubExtensions,
} from "#src/backend/lib/effect/test-layers";
import type {
  ConformanceConnection,
  ConformanceDatabase,
} from "#src/backend/persistence/conformance/support";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";
import { cronTimers } from "#src/backend/persistence/conformance/schedule-support";
import { postWorkflowsBulkLifecycle } from "#src/backend/services/workflows/bulk-actions";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

/** At midnight UTC on January 1, so a run of this file sees one next slot. */
const YEARLY: CronSchedule = { cron: "0 0 1 1 *", timeZone: "UTC" };

const scheduledGraph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        type: "lifecycle",
        label: "Yearly report",
        config: {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "first-wins",
            schedules: [YEARLY],
          },
        },
      },
    },
  ],
  edges: [],
});

const services = Layer.mergeAll(stubExtensions(), SilentAppLoggerLayer);

const databases: ConformanceDatabase[] = [];
const connections: ConformanceConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((one) => one.close()));
  await Promise.all(databases.splice(0).map((one) => one.drop()));
});

/** A connection on a fresh database holding one unpublished workflow. */
async function withWorkflow(): Promise<{
  database: ConformanceDatabase;
  connection: ConformanceConnection;
}> {
  const database = await createSqliteTestDatabase();
  databases.push(database);
  const connection = await database.open();
  connections.push(connection);
  await connection.run(
    Effect.gen(function* () {
      const workflows = yield* WorkflowRepo;
      yield* workflows.insert({
        id: "wf_yearly",
        name: "Yearly report",
        graph: scheduledGraph,
        eventSubscriptions: [],
      });
    })
  );
  return { database, connection };
}

/** The workflow's timers, earliest `wake_at` first. */
function timers(database: ConformanceDatabase) {
  return cronTimers(database, "wf_yearly");
}

/** Publishes `scheduledGraph` through the Publish service. */
const publish = publishWorkflow({
  workflowId: "wf_yearly",
  graph: scheduledGraph,
  expectedPublishedVersionId: null,
  expectedDraftRevision: 1,
}).pipe(Effect.provide(services));

function bulk(action: "pause" | "resume") {
  return postWorkflowsBulkLifecycle({
    workflowIds: ["wf_yearly"],
    action,
  }).pipe(Effect.provide(services));
}

describe("cron timers through the workflow services", () => {
  it("writes a timer at Publish for the schedule the published graph declares, due at its next slot", async () => {
    const { database, connection } = await withWorkflow();
    const before = new Date();
    const result = await connection.run(
      Effect.gen(function* () {
        const unpublished = yield* timers(database);
        yield* publish;
        return { unpublished, published: yield* timers(database) };
      })
    );

    expect(result.unpublished).toEqual([]);
    expect(result.published).toEqual([
      expect.objectContaining({
        kind: "cron",
        workflowId: "wf_yearly",
        ...YEARLY,
        state: "waiting",
        ownerToken: null,
        wakeAt: nextFireAfter(YEARLY, before),
      }),
    ]);
  });

  it("deletes the timers when the bulk pause pauses the workflow, and writes them again on resume", async () => {
    const { database, connection } = await withWorkflow();
    const result = await connection.run(
      Effect.gen(function* () {
        yield* publish;
        const paused = yield* bulk("pause");
        const whilePaused = yield* timers(database);
        const resumed = yield* bulk("resume");
        return {
          paused,
          whilePaused,
          resumed,
          afterResume: yield* timers(database),
        };
      })
    );

    expect(result.paused.summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.whilePaused).toEqual([]);
    expect(result.resumed.summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.afterResume).toEqual([
      expect.objectContaining({
        ...YEARLY,
        state: "waiting",
        ownerToken: null,
      }),
    ]);
  });
});
