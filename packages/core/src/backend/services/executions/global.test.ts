// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExecutorHold,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionPageQuery,
  GlobalExecutionRow,
} from "#src/backend/services/executions/repo";
import { getWorkflowExecutionsGlobal } from "#src/backend/services/executions/global";

function createRow(
  overrides: Partial<GlobalExecutionRow> & { id: string; startedAt: Date }
): GlobalExecutionRow {
  return {
    workflowId: "wf_1",
    workflowName: "Workflow A",
    workflowIsPaused: false,
    status: "completed",
    startSource: "manual",
    runMode: "live",
    startEventName: null,
    entityValue: null,
    versionKind: "published",
    versionNumber: 1,
    error: null,
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    ...overrides,
  };
}

const page = [
  createRow({
    id: "exec_3",
    workflowId: "wf_1",
    workflowName: "Workflow A",
    status: "running",
    startedAt: new Date("2026-02-18T19:40:00.000Z"),
  }),
  createRow({
    id: "exec_2",
    workflowId: "wf_2",
    workflowName: "Workflow B",
    workflowIsPaused: true,
    status: "waiting",
    startSource: "event",
    runMode: "test",
    startEventName: "order.updated",
    entityValue: "ord_2",
    startedAt: new Date("2026-02-18T19:39:00.000Z"),
    waitingAt: new Date("2026-02-18T19:39:10.000Z"),
  }),
  createRow({
    id: "exec_1",
    workflowId: "wf_3",
    workflowName: "Workflow C",
    startedAt: new Date("2026-02-18T19:38:00.000Z"),
    completedAt: new Date("2026-02-18T19:38:20.000Z"),
    duration: "20000",
  }),
];

/**
 * A repository that answers one page and records what it was asked for.
 *
 * The query it receives is half of what these tests are about: the service is
 * the only thing that knows a page is fetched one row longer than the caller
 * asked for, and that a cursor arrives as text and reaches the database as a
 * `Date`. Built per test rather than reset between them, so no test can see the
 * calls another one made.
 */
function makeExecutionRepo(rows: GlobalExecutionRow[]) {
  const calls = {
    pages: [] as ExecutionPageQuery[],
    activities: [] as string[][],
  };

  // The runs list reads nothing else, so every other method refuses. The
  // executor holds `exec_3`, whose worker stopped renewing its lease, and
  // `exec_2`, which is asleep on its parks, a case a list row does not show.
  const repoLayer = stubExecutionRepo({
    listPage: (query) =>
      Effect.sync(() => {
        calls.pages.push(query);
        return rows.slice(0, query.limit);
      }),
    listExecutorHolds: (executionIds) =>
      Effect.sync(() => {
        calls.activities.push([...executionIds]);
        return new Map([
          [
            "exec_3",
            stubExecutorHold({
              state: "leased",
              workerId: "worker_1",
              runningStepId: "node:send:dispatch",
              runningNodeId: "send",
              runningNodeName: "Send reminder",
              leaseExpiresAt: new Date("2026-02-18T19:41:00.000Z"),
            }),
          ],
          [
            "exec_2",
            stubExecutorHold({
              state: "waiting",
              wakeAt: new Date("2026-03-01T00:00:00.000Z"),
            }),
          ],
        ]);
      }),
  });

  return { layer: repoLayer, calls };
}

describe("getWorkflowExecutionsGlobal", () => {
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      makeAppContextLayer({ apiBasePath: "/api" })
    )
  )((it) => {
    it.effect("returns paginated global workflow executions with cursor", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page);

        const result = yield* getWorkflowExecutionsGlobal({ limit: 2 }).pipe(
          Effect.provide(repo.layer)
        );

        assert.lengthOf(result.items, 2);
        assert.strictEqual(result.items[0]?.id, "exec_3");
        assert.strictEqual(result.items[1]?.workflowIsPaused, true);
        assert.deepStrictEqual(result.nextCursor, {
          startedAt: "2026-02-18T19:39:00.000Z",
          id: "exec_2",
        });
        assert.isNull(result.runRetentionMs);
      })
    );

    it.effect("answers the host's run retention window", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page);

        const result = yield* getWorkflowExecutionsGlobal({ limit: 2 }).pipe(
          Effect.provide(
            Layer.merge(
              repo.layer,
              makeAppContextLayer({
                apiBasePath: "/api",
                runRetentionMs: 2_592_000_000,
              })
            )
          )
        );

        assert.strictEqual(result.runRetentionMs, 2_592_000_000);
      })
    );

    // One read for the page, asking only about the runs still in progress.
    it.effect("answers each in-progress run's executor activity", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-02-18T19:45:00.000Z"));
        const repo = makeExecutionRepo(page);

        const result = yield* getWorkflowExecutionsGlobal({}).pipe(
          Effect.provide(repo.layer)
        );

        assert.deepStrictEqual(repo.calls.activities, [["exec_3", "exec_2"]]);
        assert.deepStrictEqual(
          result.items.map((item) => item.activity),
          [
            {
              kind: "lease_expired",
              nodeId: "send",
              nodeName: "Send reminder",
              since: "2026-02-18T19:41:00.000Z",
            },
            null,
            null,
          ]
        );
      })
    );

    it.effect("leaves start and result payloads off the list", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo([
          createRow({
            id: "exec_secret",
            startedAt: new Date("2026-02-18T19:40:00.000Z"),
            error: "Authorization: Bearer error-secret",
          }),
        ]);

        const result = yield* getWorkflowExecutionsGlobal({}).pipe(
          Effect.provide(repo.layer)
        );

        assert.strictEqual("input" in (result.items[0] ?? {}), false);
        assert.strictEqual("output" in (result.items[0] ?? {}), false);
        assert.notInclude(result.items[0]?.error ?? "", "error-secret");
      })
    );

    it.effect("asks for one row more than the page it answers with", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page);

        yield* getWorkflowExecutionsGlobal({
          limit: 2,
          workflowIds: ["wf_1", "wf_1", "wf_2"],
          statuses: ["running", "running"],
          cursor: { startedAt: "2026-02-18T19:41:00.000Z", id: "exec_4" },
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(repo.calls.pages, [
          {
            workflowIds: ["wf_1", "wf_2"],
            statuses: ["running"],
            cursor: {
              startedAt: new Date("2026-02-18T19:41:00.000Z"),
              id: "exec_4",
            },
            limit: 3,
          },
        ]);
      })
    );

    it.effect("stops at the end of the last page", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page.slice(0, 2));

        const result = yield* getWorkflowExecutionsGlobal({ limit: 2 }).pipe(
          Effect.provide(repo.layer)
        );

        assert.lengthOf(result.items, 2);
        assert.strictEqual(result.nextCursor, null);
      })
    );

    it.effect("refuses an invalid cursor timestamp without querying", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page);

        const failure = yield* getWorkflowExecutionsGlobal({
          cursor: {
            startedAt: "not-a-date",
            id: "exec_bad",
          },
        }).pipe(Effect.provide(repo.layer), Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.strictEqual(failure.error, "Invalid cursor.startedAt timestamp");
        assert.deepStrictEqual(repo.calls.pages, []);
      })
    );

    it.effect("refuses a limit outside the range it will serve", () =>
      Effect.gen(function* () {
        const repo = makeExecutionRepo(page);

        const failure = yield* getWorkflowExecutionsGlobal({ limit: 501 }).pipe(
          Effect.provide(repo.layer),
          Effect.flip
        );

        assert.instanceOf(failure, InvalidInput);
        assert.strictEqual(failure.error, "Limit must be between 1 and 500");
        assert.deepStrictEqual(repo.calls.pages, []);
      })
    );
  });
});
