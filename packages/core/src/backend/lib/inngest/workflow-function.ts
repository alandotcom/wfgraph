import { type Inngest, type InngestFunction, NonRetriableError } from "inngest";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { executionError } from "#src/backend/engine/contracts";
import {
  executeWorkflow,
  type WorkflowExecutionInput,
} from "#src/backend/engine/core";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  workflowExecutionInputSchema,
  workflowRunCancelRequested,
  workflowRunRequested,
} from "#src/backend/lib/inngest/events";

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

/**
 * The trigger carries `workflowExecutionInputSchema`, and Inngest validates
 * against it before calling this handler, so `event.data` arrives parsed. A
 * payload that fails raises `EventValidationError`, which extends
 * `NonRetriableError`: a malformed run fails once instead of spending all four
 * retries re-deserializing the same bad JSON.
 *
 * `step` stays structurally typed rather than taken from the SDK's context, so
 * the shape this handler depends on is stated in one readable place.
 */
async function workflowRunRequestedHandler({
  event,
  step,
  actions,
  store,
}: {
  event: { data: typeof workflowExecutionInputSchema.Type };
  actions: WorkflowActions;
  store: WorkflowStore;
  step: {
    sleep: (id: string, durationMs: number) => Promise<void>;
    waitForEvent: (
      id: string,
      options: { event: string; if?: string; timeout: string }
    ) => Promise<unknown>;
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  };
}) {
  const data: WorkflowExecutionInput = event.data;
  const runtime: WorkflowExecutionRuntime = {
    sleep: async (stepId, durationMs) => {
      if (durationMs <= 0) {
        return;
      }
      await step.sleep(stepId, durationMs);
    },
    waitForEvent: async (stepId, options) =>
      await step.waitForEvent(stepId, {
        event: options.event,
        if: options.ifExpression,
        timeout:
          options.timeoutMs === undefined
            ? "365d"
            : toDurationString(options.timeoutMs),
      }),
    // Memoization boundary: Inngest stores the result under `stepId`, so work
    // already done in an earlier attempt is replayed instead of repeated.
    run: (stepId, fn) => step.run(stepId, fn),
  };

  // The engine persists nothing and implements nothing on its own: the store
  // and the dispatch port are the app's, built where the function was.
  const result = await executeWorkflow(data, runtime, store, actions);
  if (!result.success) {
    // A run that died carries one sentence; a run that finished with failed
    // nodes carries one per node, and naming them is the whole of what Inngest
    // shows for the attempt.
    let message = "Workflow execution failed";
    if (typeof result.error === "string") {
      message = result.error;
    } else {
      const failed = Object.entries(result.results).flatMap(
        ([nodeId, nodeResult]) => {
          const nodeError = executionError(nodeResult);
          return nodeError ? [`${nodeId}: ${nodeError}`] : [];
        }
      );
      if (failed.length > 0) {
        message = failed.join("; ");
      }
    }
    // Both of the engine's exits write the run's terminal row inside a memoized
    // step, so another attempt of this body reads that write back out of the
    // memo and the row keeps the verdict it already has. `finishRun` updates an
    // in-flight row alone, so a corrective write is refused in any case, and a
    // Wait node reached on the way would find `createWaitState` declining to
    // park a terminal run. What a retry can still mend is a step, and Inngest
    // retries one inside the body without ever reaching this line.
    throw new NonRetriableError(message);
  }
  return result;
}

/**
 * Every run in the app, on one function.
 *
 * The trigger carries no per-workflow filter, so which workflows exist is a
 * question this function never asks: one saved a moment ago runs on the same
 * registration, and Inngest needs no re-sync. Which graph a run walks is on the
 * event, put there by whoever enqueued it.
 *
 * The Inngest dashboard therefore labels every run alike. The workflow's name
 * reaches a trace through the `rova.workflow.name` attribute the engine's span
 * carries.
 *
 * The return type is stated because declaration emit cannot name the inferred
 * one: it references types inngest keeps internal (`SendSignalResponse` under
 * inngest/api). `InngestFunction.Any` is what the served function list collects
 * these into anyway.
 */
export function createWorkflowRunFunction(
  client: Inngest,
  input: {
    /**
     * Where an action id becomes work, built by the app from its own surface.
     *
     * Called once per invocation of the body rather than once per process: the
     * surface holds an integration's credentials for its own lifetime, and a
     * decrypted secret must not outlive the invocation that read it.
     */
    actions: () => WorkflowActions;
    /** Where a run's rows go, built by the app from its own runtime. */
    store: WorkflowStore;
  }
): InngestFunction.Any {
  return client.createFunction(
    {
      id: "workflow-run",
      name: "Workflow run",
      // The count a step is retried under. Inngest re-runs this body to retry
      // one, resuming at the step that failed rather than replaying the graph's
      // work, so this is not 0: without it a single transient fault - a provider
      // 502, a blip writing a step log - ends the node on its first refusal. A
      // run that recorded a terminal status ends non-retriably instead and
      // spends none of these.
      //
      // What is remembered is what a handler put in its own `step.run`, plus the
      // run-log row the engine opens around it. Rova wraps no handler body
      // (ADR-0009), so a handler that wraps nothing repeats its work on every
      // attempt.
      //
      // The residual risk is a non-idempotent step that fails *after* its side
      // effect landed (a send that times out waiting for the response): the
      // retry sends again. Steps that must not double-fire should pass an
      // idempotency key to their provider rather than rely on this count.
      retries: 4,
      triggers: [{ event: workflowRunRequested }],
      cancelOn: [
        {
          event: workflowRunCancelRequested,
          if: "async.data.executionId == event.data.executionId",
        },
      ],
    },
    async (context) =>
      await workflowRunRequestedHandler({
        ...context,
        actions: input.actions(),
        store: input.store,
      })
  );
}
