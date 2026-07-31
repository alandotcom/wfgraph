/**
 * A host's own action, as the engine calls a step.
 *
 * `createAction` already validates the resolved config against the author's
 * schema, encodes what `execute` answered through the output schema when there
 * is an Effect one, and turns a throw into a failed envelope. What is left is
 * reading `_context` out of the input record. The run log rows are the engine's,
 * written through its store around this call, and the runner a `defineStep`
 * action needs has no use here: a host's `execute` is a Promise and asks Rova
 * for no services.
 */

import {
  readStepContext,
  stripInternalFields,
} from "#src/backend/lib/steps/step-handler";
import type { StepFactory } from "#src/backend/lib/steps/step-runner";
import type { RuntimeActionExecute } from "@rova/shared/workflow/action-registry";

function readIntegrationId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** What this dispatch reads off a host's action: nothing beyond its id and its implementation. */
type DispatchableAction = { id: string; execute: RuntimeActionExecute };

export function hostActionStep(action: DispatchableAction): StepFactory {
  return () => async (rawInput) => {
    const context = readStepContext(rawInput._context);

    // Every node the engine runs carries its context, so an input without one is
    // a Rova bug rather than something a host wrote. It fails the node here
    // because the alternative is handing an author the node ids they were
    // promised as empty strings, and a run log naming a node that does not exist.
    if (!context) {
      return {
        success: false,
        error: {
          message: `Action "${action.id}" was called without a step context, so the node it belongs to cannot be identified.`,
        },
      };
    }

    return await action.execute({
      // The same three keys a run log leaves out: `execute` is told about the
      // connection and the action through its context instead.
      payload: stripInternalFields(rawInput),
      context: {
        ...context,
        integrationId: readIntegrationId(rawInput.integrationId),
      },
    });
  };
}
