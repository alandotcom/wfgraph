import { stripInternalFields } from "#src/backend/extensions/steps/step-handler";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import type { NodeSteps } from "@rova/shared/actions/step-result";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { Effect } from "effect";
import {
  executionResultFromStepResult,
  failedExecution,
} from "#src/backend/engine/contracts";
import { engineFailure } from "#src/backend/engine/engine-failure";

export function runPluginActionStep(input: ActionStepInput) {
  return Effect.gen(function* () {
    const { actionType, config, context, store, actions, runtime } = input;

    if (input.catalogFingerprint !== actions.catalogFingerprint()) {
      return {
        result: failedExecution(
          engineFailure(
            "failure",
            "Extension catalog changed since this workflow version was published. Republish the workflow against the current catalog, or restore the previous deploy."
          )
        ),
      };
    }

    const stepInput: Record<string, unknown> = {
      ...config,
      _context: context,
    };

    const stepFunction = actions.stepFor(actionType);
    if (!stepFunction) {
      // No row is written for an action nothing implements: there is no node work
      // to record, and the failure is reported by the traversal instead.
      return {
        result: failedExecution(
          engineFailure(
            "failure",
            `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${Object.values(BUILT_IN_ACTION_IDS).join(", ")}.`
          )
        ),
      };
    }

    // Rova namespaces the id, so an author writes "post" and two nodes running
    // the same action do not write to one another's memoized result.
    const steps: NodeSteps = {
      run: (stepId, work) =>
        runtime.run(`node:${context.nodeId}:${stepId}`, work),
    };

    const result = yield* runWithStepLog(
      // The rows carry the input as the node was configured, minus the three keys
      // the engine's own dispatch owns.
      { store, context, runtime, input: stripInternalFields(stepInput) },
      () => stepFunction(stepInput, steps)
    );

    return { result: executionResultFromStepResult(result) };
  });
}
