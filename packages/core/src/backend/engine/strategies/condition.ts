import {
  conditionLogger,
  evaluateConditionExpression,
} from "#src/backend/engine/conditions";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import type { StepResult } from "@rova/shared/actions/step-result";

export async function runConditionStep(
  input: ActionStepInput
): Promise<{ result: StepResult; conditionValue: boolean }> {
  const { config, outputs, context, store, runtime } = input;

  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  const originalExpression = stepInput.condition;
  const { result: evaluatedCondition } = evaluateConditionExpression(
    originalExpression,
    outputs,
    config.conditionModel,
    input.eventName
  );
  conditionLogger.debug("Condition evaluation result", {
    evaluatedCondition,
  });

  const result = await runWithStepLog(
    {
      store,
      context,
      runtime,
      input: {
        condition: evaluatedCondition,
        ...(typeof originalExpression === "string"
          ? { expression: originalExpression }
          : {}),
      },
    },
    () =>
      Promise.resolve({
        success: true,
        data: { condition: evaluatedCondition },
      })
  );

  return { result, conditionValue: evaluatedCondition };
}
