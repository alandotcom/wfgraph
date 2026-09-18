// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import { getExecutionStatus } from "#src/backend/services/executions/status";

describe("getExecutionStatus", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // A node parked on a Wait records a running status, so the read names the
    // nodes holding an open wait beside the node statuses.
    it.effect("answers the open waits' node ids with the node statuses", () =>
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
        });
      })
    );
  });
});
