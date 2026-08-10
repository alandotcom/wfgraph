// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionSummary } from "#src/backend/services/executions/repo";
import { getExecutionLogs } from "#src/backend/services/executions/logs";

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowVersionId: "ver_1",
    status: "completed",
    startSource: "event",
    runMode: "live",
    startEventName: "app/appointment.created",
    entityValue: "appt_1",
    input: null,
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    completedAt: new Date("2026-03-01T10:00:01.000Z"),
    duration: "1000",
    ...overrides,
  };
}

/** The three reads this service makes, with the summary the test chose. */
function makeRepos(execution: ExecutionSummary | null) {
  return Layer.mergeAll(
    SilentAppLoggerLayer,
    stubExecutionRepo({
      findSummaryById: () => Effect.succeed(execution),
      listLogs: () => Effect.succeed([]),
      listWaitingStates: () => Effect.succeed([]),
    })
  );
}

describe("getExecutionLogs", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // The graph itself rides `getVersionGraph` now (#37); this payload still
    // has to carry the version id that procedure is keyed by, or the client
    // has nothing to fetch the graph with.
    it.effect("carries the pinned version id the graph is fetched by", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(makeRepos(summary({ workflowVersionId: "ver_9" })))
        );

        assert.strictEqual(result.execution.workflowVersionId, "ver_9");
      })
    );

    // Start identity rides in the same thinner summary so a past-cap deep link
    // can still label Test Mode / event / entity without a list row.
    it.effect("hands start identity through on the execution summary", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(
            makeRepos(
              summary({
                runMode: "test",
                startSource: "event",
                startEventName: "order.updated",
                entityValue: "ord_2",
              })
            )
          )
        );

        assert.strictEqual(result.execution.runMode, "test");
        assert.strictEqual(result.execution.startSource, "event");
        assert.strictEqual(result.execution.startEventName, "order.updated");
        assert.strictEqual(result.execution.entityValue, "ord_2");
      })
    );

    it.effect("redacts execution input and output beside the node logs", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(
            makeRepos(
              summary({
                input: { password: "input-secret" },
                output: { apiToken: "output-secret" },
              })
            )
          )
        );

        assert.deepStrictEqual(result.execution.input, {
          password: "********cret",
        });
        assert.deepStrictEqual(result.execution.output, {
          apiToken: "********cret",
        });
      })
    );

    it.effect("answers not-found when the run is gone", () =>
      Effect.gen(function* () {
        const failure = yield* getExecutionLogs("exec_gone").pipe(
          Effect.provide(makeRepos(null)),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "NotFound");
      })
    );
  });
});
