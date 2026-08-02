import { type NodeContext, runWithStepLog } from "#src/backend/engine/step-log";
import type {
  NodeStrategy,
  NodeWorkContext,
  NodeWorkOutcome,
} from "#src/backend/engine/strategies/types";
import { LIFECYCLE_STARTED_HANDLE } from "@rova/shared/lifecycle/lifecycle-outlets";
import type { JsonObject } from "@rova/shared/types/json";

async function runLifecycle(ctx: NodeWorkContext): Promise<NodeWorkOutcome> {
  const { node, nodeName, logger, store, runtime, executionId, startPayload } =
    ctx;

  logger.debug("Executing lifecycle node");

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
  const lifecycleResult = await runWithStepLog(
    {
      store,
      context: lifecycleContext,
      runtime,
      input: { lifecycleData },
    },
    () => Promise.resolve({ success: true as const, data: lifecycleData })
  );

  return { result: lifecycleResult };
}

export const lifecycleStrategy: NodeStrategy = {
  id: "lifecycle",
  run: runLifecycle,
  routeAfter: () => ({ kind: "outlet", outlet: LIFECYCLE_STARTED_HANDLE }),
};
