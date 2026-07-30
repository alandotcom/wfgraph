/**
 * A host's own action, as the engine calls a step.
 *
 * `createAction` already validates the resolved config against the author's
 * schema and turns a throw into a failed envelope, so what is left is the two
 * things the engine asks of every step: the run log rows, and reading `_context`
 * out of the input record. `defineStep` does both for an integration's action, and
 * a great deal more that a host action has no schemas to support.
 */

import {
  readStepContext,
  stripInternalFields,
  withStepLogging,
} from "#src/backend/lib/steps/step-handler";
import type { RuntimeActionDefinition } from "@rova/shared/workflow/action-registry";
import type { StepFunction } from "@rova/shared/workflow/step-result";

function readIntegrationId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function hostActionStep(action: RuntimeActionDefinition): StepFunction {
  return async (rawInput) => {
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

    return await withStepLogging({ ...rawInput, _context: context }, () =>
      Promise.resolve(
        action.execute({
          // The same three keys a run log leaves out: `execute` is told about the
          // connection and the action through its context instead.
          payload: stripInternalFields(rawInput),
          context: {
            ...context,
            integrationId: readIntegrationId(rawInput.integrationId),
          },
        })
      )
    );
  };
}
