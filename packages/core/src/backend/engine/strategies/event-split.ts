import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import type { StepResult } from "@rova/shared/actions/step-result";

export async function runEventSplitStep(
  input: ActionStepInput
): Promise<{ result: StepResult }> {
  const { context, store, runtime } = input;

  const result = await runWithStepLog(
    { store, context, runtime, input: { event: input.eventName } },
    () => Promise.resolve({ success: true, data: { event: input.eventName } })
  );

  return { result };
}
