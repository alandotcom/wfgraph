/**
 * Executable step function for Condition action
 */

import { type StepInput, withStepLogging } from "./step-handler";

export type ConditionInput = StepInput & {
  condition: boolean;
  /** Original condition expression string for logging (e.g., "{{@nodeId:Label.field}} === 'good'") */
  expression?: string;
  /** Resolved values of template variables for logging (e.g., { "Label.field": "actual_value" }) */
  values?: Record<string, unknown>;
};

type ConditionResult = {
  condition: boolean;
};

function evaluateCondition(input: ConditionInput): ConditionResult {
  return { condition: input.condition };
}

export function conditionStep(input: ConditionInput): Promise<ConditionResult> {
  return withStepLogging(input, () =>
    Promise.resolve(evaluateCondition(input))
  );
}
conditionStep.maxRetries = 0;
