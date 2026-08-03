/**
 * Closed strategy table for node work.
 *
 * The scheduler resolves one strategy per node, runs it, then asks
 * `routeAfterStrategy` how to leave. Built-in name checks live here and in the
 * action strategy's internal dispatch — not in the scheduler class body.
 */

import { actionStrategy } from "#src/backend/engine/strategies/action";
import { lifecycleStrategy } from "#src/backend/engine/strategies/lifecycle";
import type {
  NodeStrategy,
  NodeWorkContext,
  NodeWorkOutcome,
} from "#src/backend/engine/strategies/types";
import type { TraversalRoute } from "#src/backend/engine/traversal";
import {
  isConditionNode,
  isEventSplitActionNode,
} from "@rova/shared/graph/node-config";
import type { ConditionBranch, WorkflowNode } from "@rova/shared/graph/types";
import { isEventSplitNode } from "@rova/shared/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "@rova/shared/lifecycle/lifecycle-outlets";
import { Effect } from "effect";
import { failedExecution } from "#src/backend/engine/contracts";
import { engineFailure } from "#src/backend/engine/engine-failure";

export type { NodeStrategy, NodeWorkContext, NodeWorkOutcome };

export function resolveStrategy(node: WorkflowNode): NodeStrategy {
  if (node.data.type === "lifecycle") {
    return lifecycleStrategy;
  }
  if (node.data.type === "action") {
    return actionStrategy;
  }
  return unknownNodeStrategy;
}

const unknownNodeStrategy: NodeStrategy = {
  id: "unknown",
  run: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.logError("Unknown node type");
      return {
        result: failedExecution(
          engineFailure(
            "failure",
            `Unknown node type "${ctx.node.data.type}" in node "${ctx.node.data.label || ctx.node.id}". Expected "lifecycle" or "action".`
          )
        ),
      };
    }),
};

/**
 * Which edges a finished node hands the run along.
 *
 * Condition reads its boolean from the outcome; Lifecycle and Event Split are
 * decided from the node kind; everything else fans out on every edge.
 */
export function routeAfterStrategy(
  node: WorkflowNode,
  eventName: string | null,
  outcome: NodeWorkOutcome
): TraversalRoute | null {
  if (isConditionNode(node)) {
    const conditionResult = outcome.conditionValue;
    if (conditionResult !== true && conditionResult !== false) {
      return null;
    }
    const branch: ConditionBranch = conditionResult ? "true" : "false";
    return { kind: "condition", branch };
  }

  if (node.data.type === "lifecycle") {
    return { kind: "outlet", outlet: LIFECYCLE_STARTED_HANDLE };
  }

  if (isEventSplitNode(node) || isEventSplitActionNode(node)) {
    return { kind: "event", eventName };
  }

  return { kind: "all" };
}

export function isRoutingNode(node: WorkflowNode): boolean {
  return isConditionNode(node) || isEventSplitNode(node);
}
