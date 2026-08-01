/**
 * The assembled surface, as the engine's dispatch port.
 *
 * The surface knows which action id maps to which step; what a step still needs
 * is the credential store its integration's secrets are read through, which
 * reads the catalog the same surface carries, and the runtime to run on. Binding
 * the three here is the whole reason a definition answers a factory rather than
 * a step.
 */

import { Cause, Effect } from "effect";
import { findAction } from "@rova/shared/extensions/catalog";
import { literalFieldKeys } from "@rova/shared/plugins/action-fields";
import { fetchCredentials } from "#src/backend/extensions/credential-fetcher";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { StepEnvironment } from "#src/backend/extensions/steps/step-runner";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  type BaseMiddleware,
  stepContextFor,
} from "#src/backend/extensions/middleware";
import type { RovaRuntime } from "#src/backend/runtime";

export function createWorkflowActions(
  extensions: ExtensionSet,
  runtime: RovaRuntime,
  middleware: readonly BaseMiddleware[] = []
): WorkflowActions {
  const app: StepEnvironment = {
    // Which stored key holds which credential is the integration's own
    // declaration, which the catalog carries, so the surface a node was
    // assembled with is the one its secrets are read through.
    credentialsFor: (integrationId) =>
      fetchCredentials(extensions.catalog, runtime, integrationId),
    // The whole step runs against the app's services, and the failure it could
    // not answer for arrives here as a rejected promise, which is what the
    // engine's durable runtime reads as a step to run again.
    runStep: (effect) => runStepToCompletion(runtime, effect),
  };

  return {
    stepFor: (actionType) => extensions.stepFor(actionType)?.(app),
    metadataFor: (actionType) => {
      const action = findAction(extensions.catalog, actionType);
      if (!action) {
        return undefined;
      }

      return {
        label: action.label,
        literalConfigKeys: literalFieldKeys(action.configFields),
      };
    },
    // Run per node rather than once per app: a middleware is told which action it
    // is serving, so it may answer differently for one.
    contextFor: (actionType) => stepContextFor(middleware, actionType),
  };
}

/**
 * Runs a step uninterruptibly, delivering its answer from inside that region.
 *
 * `ManagedRuntime.dispose` closes the scope its fibers run in, and an
 * interrupted fiber answers with the interruption even where the work had
 * already finished. A step that loses its answer that way rejects, the durable
 * runtime reads the rejection as a step to run again, and the second SMS goes
 * out to record the first. Delivering the outcome from inside the region is the
 * one place an interruption cannot overtake it. The cost is a shutdown that
 * waits out whatever a handler is in the middle of.
 */
function runStepToCompletion<A, E>(
  runtime: RovaRuntime,
  effect: Effect.Effect<A, E>
): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const fiber = runtime.runFork(
      Effect.uninterruptible(
        Effect.matchCauseEffect(effect, {
          onSuccess: (value) => Effect.sync(() => resolve(value)),
          // `Cause.squash` is what `runPromise` throws, so a typed failure still
          // reaches the engine as the error object the step failed with.
          onFailure: (cause) => Effect.sync(() => reject(Cause.squash(cause))),
        })
      )
    );

    // A step dispatched after dispose is interrupted before either handler runs,
    // and its promise would otherwise never settle. The first settlement wins,
    // so this says nothing on the paths above.
    fiber.addObserver(() =>
      reject(new Error("The step did not run: the Rova runtime was disposed."))
    );
  });
}
