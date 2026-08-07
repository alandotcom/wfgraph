import { type NodeContext, runWithStepLog } from "#src/backend/engine/step-log";
import type {
  NodeStrategy,
  NodeWorkContext,
} from "#src/backend/engine/strategies/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { Effect } from "effect";
import { executionResultFromStepResult } from "#src/backend/engine/contracts";

function runLifecycle(ctx: NodeWorkContext) {
  return Effect.gen(function* () {
    const { node, nodeName, store, runtime, executionId, startPayload } = ctx;

    yield* Effect.logDebug("Executing lifecycle node");

    // The entry node's output is the payload and nothing else. The Event's own
    // schema validated it at intake, which is the only gate it passes through,
    // and a key the engine added here would shadow a payload field of the same
    // name.
    const lifecycleData: JsonObject = startPayload;

    const lifecycleContext: NodeContext = {
      executionId,
      nodeId: node.id,
      nodeName,
      nodeType: node.data.type,
    };

    // The entry node does no work, and its row exists so that a run's timeline
    // opens with the payload it started from.
    const lifecycleResult = yield* runWithStepLog(
      {
        store,
        context: lifecycleContext,
        runtime,
        input: { lifecycleData },
      },
      () => Effect.succeed({ success: true as const, data: lifecycleData })
    );

    return { result: executionResultFromStepResult(lifecycleResult) };
  });
}

export const lifecycleStrategy: NodeStrategy = {
  id: "lifecycle",
  run: runLifecycle,
};
