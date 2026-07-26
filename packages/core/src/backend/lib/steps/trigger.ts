/**
 * Trigger step - handles trigger execution with proper logging.
 */

import { type StepInput, withStepLogging } from "./step-handler";

type TriggerResult = {
  success: true;
  data: Record<string, unknown>;
};

export type TriggerInput = StepInput & {
  triggerData: Record<string, unknown>;
};

/**
 * Trigger logic - just passes through the trigger data
 */
function executeTrigger(input: TriggerInput): TriggerResult {
  return {
    success: true,
    data: input.triggerData,
  };
}

/**
 * Trigger Step
 * Executes a trigger and logs it properly.
 */
export function triggerStep(input: TriggerInput): Promise<TriggerResult> {
  // Normal trigger execution with logging
  return withStepLogging(input, () => Promise.resolve(executeTrigger(input)));
}
