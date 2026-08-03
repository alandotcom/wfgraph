import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import { executionResultFromStepResult } from "#src/backend/engine/contracts";
import { Effect } from "effect";

export function runEventSplitStep(input: ActionStepInput) {
  return Effect.gen(function* () {
    const { context, store, runtime } = input;

    const result = yield* runWithStepLog(
      { store, context, runtime, input: { event: input.eventName } },
      () =>
        Effect.succeed({
          success: true as const,
          data: { event: input.eventName },
        })
    );

    return { result: executionResultFromStepResult(result) };
  });
}
