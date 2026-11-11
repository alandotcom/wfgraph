import { stripInternalFields } from "#src/backend/extensions/steps/step-handler";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import type {
  NodeSteps,
  StepResult,
} from "@wfgraph/shared/actions/step-result";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { Effect } from "effect";
import {
  executionResultFromStepResult,
  failedExecution,
} from "#src/backend/engine/contracts";
import { engineFailure } from "#src/backend/engine/engine-failure";

/** What a node answers when the live catalog is not the one it was pinned to. */
const CATALOG_CHANGED: StepResult = {
  success: false,
  error: {
    message:
      "Extension catalog changed since this workflow version was published. Republish the workflow against the current catalog, or restore the previous deploy.",
  },
};

/**
 * The durable step id an author's `step.run(name)` is memoized under.
 *
 * The engine's own steps for a node sit directly under `node:<id>:`
 * (`log-open`, `route`, `handler`), and every name an author chooses sits under
 * `node:<id>:step:`, so no name an author picks can answer from, or overwrite,
 * a value the engine stored.
 */
function authorStepId(nodeId: string, name: string): string {
  return `node:${nodeId}:step:${name}`;
}

export function runPluginActionStep(input: ActionStepInput) {
  return Effect.gen(function* () {
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
        result: failedExecution(
          engineFailure(
            "failure",
            `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${Object.values(BUILT_IN_ACTION_IDS).join(", ")}.`
          )
        ),
      };
    }

    // Workflow Graph namespaces the id, so an author writes "post" and two nodes running
    // the same action do not write to one another's memoized result. The name
    // pairs that author's word with the node's label, which is what a trace shows.
    const steps: NodeSteps = {
      run: (stepName, work) =>
        runtime.run(
          {
            id: authorStepId(context.nodeId, stepName),
            nodeId: context.nodeId,
            name: `${context.nodeName}: ${stepName}`,
          },
          work
        ),
      // A host action's handler runs inside this step, and the author's steps
      // above run nested in it. The executor answers the step from its memo
      // on a later pass, so the handler is not called again.
      runHandler: (work) =>
        runtime.run(
          {
            id: `node:${context.nodeId}:handler`,
            nodeId: context.nodeId,
            name: `${context.nodeName} (handler)`,
          },
          work
        ),
    };

    // ADR-0012: a node runs only against the catalog its version was published
    // with. A node an earlier pass finished is not checked again: a replay
    // answers its work from the memo, and failing it would fail a run parked
    // below it for a deploy that changed nothing it still has to do.
    const catalogMatches =
      input.catalogFingerprint === actions.catalogFingerprint();

    const result = yield* runWithStepLog(
      // The rows carry the input as the node was configured, minus the three keys
      // the engine's own dispatch owns.
      { store, context, runtime, input: stripInternalFields(stepInput) },
      ({ finishedBefore }) =>
        catalogMatches || finishedBefore
          ? stepFunction(stepInput, steps)
          : Effect.succeed(CATALOG_CHANGED)
    );

    return { result: executionResultFromStepResult(result) };
  });
}
