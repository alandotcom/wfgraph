// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import { getExecutionStatus } from "#src/backend/services/executions/status";

/** A failing memo row of `nodeId`, as the executor state read answers one. */
function failingStep(stepId: string, nodeId: string | null) {
  return {
    stepId,
    nodeId,
    nodeName: null,
    failures: 1,
    error: "vendor timed out",
  };
}

describe("getExecutionStatus", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // A node parked on a Wait records a running status, so the read names the
    // nodes holding an open wait beside the node statuses, and the nodes with
    // a step that will run again.
    it.effect(
      "answers the open waits' and the retrying steps' node ids with the node statuses",
      () =>
        Effect.gen(function* () {
          const result = yield* getExecutionStatus("exec_1").pipe(
            Effect.provide(
              Layer.mergeAll(
                SilentAppLoggerLayer,
                stubExecutionRepo({
                  findStatusById: () =>
                    Effect.succeed({ id: "exec_1", status: "waiting" }),
                  listNodeStatuses: () =>
                    Effect.succeed([
                      { nodeId: "send", status: "success" },
                      { nodeId: "wait", status: "running" },
                    ]),
                  listOpenWaitNodeIds: (executionId) =>
                    Effect.succeed(executionId === "exec_1" ? ["wait"] : []),
                  // Two failing steps of one node, and one of no node.
                  findExecutorState: () =>
                    Effect.succeed({
                      state: "waiting",
                      wakeAt: new Date("2026-03-01T10:00:00.000Z"),
                      attempt: 0,
                      runningStepId: null,
                      runningNodeId: null,
                      runningNodeName: null,
                      leaseExpiresAt: null,
                      workerId: null,
                      lastError: "vendor timed out",
                      failingSteps: [
                        failingStep("node:fetch:read", "fetch"),
                        failingStep("node:fetch:write", "fetch"),
                        failingStep("delivery-step", null),
                      ],
                      unconsumedWakes: [],
                    }),
                })
              )
            )
          );

          assert.deepStrictEqual(result, {
            status: "waiting",
            nodeStatuses: [
              { nodeId: "send", status: "success" },
              { nodeId: "wait", status: "running" },
            ],
            openWaitNodeIds: ["wait"],
            retryingNodeIds: ["fetch"],
          });
        })
    );

    // A run whose own retries ran out ends `failed` with the node it was on
    // still open, the way a canceled or superseded run leaves its nodes. A
    // node that failed keeps its own error.
    it.effect.each(["failed", "canceled", "superseded"] as const)(
      "answers a %s run's open nodes as cancelled",
      (status) =>
        Effect.gen(function* () {
          const result = yield* getExecutionStatus("exec_1").pipe(
            Effect.provide(
              Layer.mergeAll(
                SilentAppLoggerLayer,
                stubExecutionRepo({
                  findStatusById: () =>
                    Effect.succeed({ id: "exec_1", status }),
                  listNodeStatuses: () =>
                    Effect.succeed([
                      { nodeId: "send", status: "success" },
                      { nodeId: "read", status: "error" },
                      { nodeId: "join", status: "running" },
                      { nodeId: "next", status: "pending" },
                    ]),
                  listOpenWaitNodeIds: () => Effect.succeed([]),
                })
              )
            )
          );

          assert.deepStrictEqual(result.nodeStatuses, [
            { nodeId: "send", status: "success" },
            { nodeId: "read", status: "error" },
            { nodeId: "join", status: "cancelled" },
            { nodeId: "next", status: "cancelled" },
          ]);
        })
    );
  });
});
