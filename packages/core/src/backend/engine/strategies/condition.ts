import { evaluateConditionExpression } from "#src/backend/engine/conditions";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import { executionResultFromStepResult } from "#src/backend/engine/contracts";
import { Effect } from "effect";

export function runConditionStep(input: ActionStepInput) {
  return Effect.gen(function* () {
    const { config, outputs, context, store, runtime } = input;

    const stepInput: Record<string, unknown> = {
      ...config,
      _context: context,
    };

    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = yield* evaluateConditionExpression(
      originalExpression,
      outputs,
      config.conditionModel,
      input.eventName
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
