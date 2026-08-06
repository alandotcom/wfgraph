// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionSummary } from "#src/backend/services/executions/repo";
import { getExecutionLogs } from "#src/backend/services/executions/logs";

const pinnedGraph: SerializedWorkflowGraph = { nodes: [], edges: [] };

type SummaryWithPinnedGraph = ExecutionSummary & {
  graph: SerializedWorkflowGraph;
};

function summary(
  overrides: Partial<SummaryWithPinnedGraph> = {}
): SummaryWithPinnedGraph {
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
    graph: pinnedGraph,
    ...overrides,
  };
}

/** The three reads this service makes, with the summary the test chose. */
function makeRepos(execution: SummaryWithPinnedGraph | null) {
  return Layer.mergeAll(
    SilentAppLoggerLayer,
    stubExecutionRepo({
      findSummaryWithPinnedGraph: () => Effect.succeed(execution),
      listLogs: () => Effect.succeed([]),
      listWaitingStates: () => Effect.succeed([]),
    })
  );
}

describe("getExecutionLogs", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // Every run pins a version, so the overlay always receives that graph —
    // not whatever the draft looks like now.
    it.effect("includes the pinned graph from the version join", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(makeRepos(summary()))
        );

        assert.deepStrictEqual(result.graph, pinnedGraph);
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
