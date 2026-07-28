// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import {
  ExecutionRepo,
  type ExecutionPageQuery,
  type GlobalExecutionRow,
} from "#src/backend/services/workflows/executions/repo";
import { getWorkflowExecutionsGlobal } from "#src/backend/services/workflows/executions/global";

function createRow(
  overrides: Partial<GlobalExecutionRow> & { id: string; startedAt: Date }
): GlobalExecutionRow {
  return {
    workflowId: "wf_1",
    workflowName: "Workflow A",
    workflowIsPaused: false,
    status: "success",
    triggerType: "manual",
    runMode: "live",
    triggerEventType: null,
    correlationKey: null,
    workflowRunId: null,
    input: null,
    output: null,
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
    workflowRunId: "run_3",
    input: { id: 3 },
    startedAt: new Date("2026-02-18T19:40:00.000Z"),
  }),
  createRow({
    id: "exec_2",
    workflowId: "wf_2",
    workflowName: "Workflow B",
    workflowIsPaused: true,
    status: "waiting",
    triggerType: "webhook",
    runMode: "test",
    triggerEventType: "order.updated",
    correlationKey: "ord_2",
    workflowRunId: "run_2",
    input: { id: 2 },
    startedAt: new Date("2026-02-18T19:39:00.000Z"),
    waitingAt: new Date("2026-02-18T19:39:10.000Z"),
  }),
  createRow({
    id: "exec_1",
    workflowId: "wf_3",
    workflowName: "Workflow C",
    workflowRunId: "run_1",
    input: { id: 1 },
    output: { ok: true },
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
  };

  const repoLayer = Layer.succeed(ExecutionRepo, {
    listPage: (query) =>
      Effect.sync(() => {
        calls.pages.push(query);
        return rows.slice(0, query.limit);
      }),
    // The runs list reads nothing else.
    listByWorkflow: () => Effect.die("listByWorkflow is not part of the page"),
    findSummaryById: () =>
      Effect.die("findSummaryById is not part of the page"),
    findStatusById: () => Effect.die("findStatusById is not part of the page"),
    existsById: () => Effect.die("existsById is not part of the page"),
    listLogs: () => Effect.die("listLogs is not part of the page"),
    listNodeStatuses: () =>
      Effect.die("listNodeStatuses is not part of the page"),
    listEvents: () => Effect.die("listEvents is not part of the page"),
    deleteAllForWorkflow: () =>
      Effect.die("deleteAllForWorkflow is not part of the page"),
  });

  return { layer: repoLayer, calls };
}

const silentLogger: EffectLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  with: () => silentLogger,
};

// The logger fake holds no state, so it belongs to the whole block. The
// repository does, so it is built inside each test instead.
const TestAppLoggerLayer = Layer.succeed(AppLogger, {
  get: () => silentLogger,
});

describe("getWorkflowExecutionsGlobal", () => {
  layer(TestAppLoggerLayer)((it) => {
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
