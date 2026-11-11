/**
 * The Condition node: decides its branch once, as a durable step, and routes
 * from that stored answer on every pass.
 *
 * The expression can read values that move between passes: CEL's `now`, and
 * node outputs a replay rebuilds. A route evaluated afresh on each pass could
 * flip after the first pass parked below one branch, so the decision is
 * memoized under `node:<id>:route` and a replay never evaluates it again.
 */

import { evaluateConditionExpression } from "#src/backend/engine/conditions";
import { runDurable } from "#src/backend/engine/durable";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import { executionResultFromStepResult } from "#src/backend/engine/contracts";
import { Effect } from "effect";

export function runConditionStep(input: ActionStepInput) {
  return Effect.gen(function* () {
    const { config, context, store, runtime } = input;

    const originalExpression = config.condition;
    const { condition: evaluatedCondition } = yield* runDurable(
      runtime,
      {
        id: `node:${context.nodeId}:route`,
        nodeId: context.nodeId,
        name: `${context.nodeName} (route)`,
      },
      evaluateConditionExpression(
        originalExpression,
        input.outputsInGraphOrder,
        config.conditionModel,
        input.eventName,
        input.entityContext
      ).pipe(Effect.map(({ result }) => ({ condition: result })))
    );
    const result = yield* runWithStepLog(
      {
        store,
        context,
        runtime,
        input: {
          condition: evaluatedCondition,
          // oxlint-disable-next-line wfgraph/no-conditional-spread -- `condition` is a builder's config value of unknown shape, so the type guard keeps `expression` to the values that really are one.
          ...(typeof originalExpression === "string"
            ? { expression: originalExpression }
            : {}),
        },
      },
      () =>
        Effect.succeed({
          success: true as const,
          data: { condition: evaluatedCondition },
        })
    );

    return {
      result: executionResultFromStepResult(result),
      conditionValue: evaluatedCondition,
    };
  });
}
