/**
 * Executable step function for Condition action
 */

import type { StepResult } from "@/shared/workflow/step-result";
import { type StepInput, withStepLogging } from "./step-handler";

export type ConditionInput = StepInput & {
  condition: boolean;
  /** Original condition expression string for logging (e.g., "{{@nodeId:Label.field}} === 'good'") */
  expression?: string;
  /** Resolved values of template variables for logging (e.g., { "Label.field": "actual_value" }) */
  values?: Record<string, unknown>;
};

/**
 * The engine evaluates the condition expression and calls this step with the
 * boolean it already holds, so the payload is that decision echoed back for the
 * run log to record.
 */
export type ConditionData = { condition: boolean };

function evaluateCondition(input: ConditionInput): StepResult<ConditionData> {
  return { success: true, data: { condition: input.condition } };
}

export function conditionStep(
  input: ConditionInput
): Promise<StepResult<ConditionData>> {
  return withStepLogging(input, () =>
    Promise.resolve(evaluateCondition(input))
  );
}
