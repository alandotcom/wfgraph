import { stripInternalFields } from "#src/backend/extensions/steps/step-handler";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import type { NodeSteps } from "@rova/shared/actions/step-result";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";

export async function runPluginActionStep(input: ActionStepInput) {
  const { actionType, config, context, store, actions, runtime } = input;

  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  const stepFunction = actions.stepFor(actionType);
  if (!stepFunction) {
    // No row is written for an action nothing implements: there is no node work
    // to record, and the failure is reported by the traversal instead.
    return {
      result: {
        success: false as const,
        error: {
          message: `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${Object.values(BUILT_IN_ACTION_IDS).join(", ")}.`,
        },
      },
    };
  }

  // Rova namespaces the id, so an author writes "post" and two nodes running
  // the same action do not write to one another's memoized result.
  const steps: NodeSteps = {
    run: (stepId, work) =>
      runtime.run(`node:${context.nodeId}:${stepId}`, work),
  };

  const result = await runWithStepLog(
    // The rows carry the input as the node was configured, minus the three keys
    // the engine's own dispatch owns.
    { store, context, runtime, input: stripInternalFields(stepInput) },
    () => Promise.resolve(stepFunction(stepInput, steps))
  );

  return { result };
}
