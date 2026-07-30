import type { Inngest, InngestFunction } from "inngest";
import { celStringLiteral } from "@rova/shared/workflow/cel-string-literal";
import type { WorkflowActions } from "#src/backend/lib/workflow-engine/actions";
import {
  executeWorkflow,
  type WorkflowExecutionInput,
} from "#src/backend/lib/workflow-engine/core";
import { dbWorkflowStore } from "#src/backend/lib/workflow-engine/db-store";
import type { WorkflowExecutionRuntime } from "#src/backend/lib/workflow-engine/runtime";
import {
  workflowExecutionInputSchema,
  workflowRunCancelRequested,
  workflowRunRequested,
} from "./events";

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

export function createWorkflowTriggerExpression(workflowId: string): string {
  return `event.data.workflowId == ${celStringLiteral(workflowId)}`;
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
}: {
  event: { data: typeof workflowExecutionInputSchema.Type };
  actions: WorkflowActions;
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
    step: (stepId, fn) => step.run(stepId, fn),
  };

  // This handler is the composition root for a live run: the engine persists
  // nothing and implements nothing on its own, so the Postgres-backed store and
  // the app's dispatch port are wired in here.
  const result = await executeWorkflow(data, runtime, dbWorkflowStore, actions);
  if ("success" in result && !result.success) {
    let message = "Workflow execution failed";
    if (typeof result.error === "string") {
      message = result.error;
    } else if (result.results) {
      const failed = Object.entries(
        result.results as Record<string, { success: boolean; error?: string }>
      )
        .filter(([, r]) => !r.success && r.error)
        .map(([nodeId, r]) => `${nodeId}: ${r.error}`);
      if (failed.length > 0) {
        message = failed.join("; ");
      }
    }
    throw new Error(message);
  }
  return result;
}

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal (`SendSignalResponse` under
// inngest/api). `InngestFunction.Any` is what the function registry collects
// these into anyway.
export function createWorkflowRunRequestedFunction(
  client: Inngest,
  input: {
    id: string;
    name?: string;
    workflowId: string;
    /** Where an action id becomes work, built by the app from its own surface. */
    actions: WorkflowActions;
  }
): InngestFunction.Any {
  return client.createFunction(
    {
      id: input.id,
      name: input.name,
      // Each node runs inside its own memoized step, so a retry resumes at the
      // step that failed instead of replaying the graph from the trigger. That
      // is what makes retrying safe here, and it is why this is not 0: without
      // it a single transient fault - a provider 502, a blip writing a step log
      // - ends the whole run with no second attempt. Only HTTP Request carries
      // its own attempt loop; every plugin action depends on this.
      //
      // The residual risk is a non-idempotent step that fails *after* its side
      // effect landed (a send that times out waiting for the response): the
      // retry sends again. Steps that must not double-fire should pass an
      // idempotency key to their provider rather than rely on this count.
      retries: 4,
      triggers: [
        {
          event: workflowRunRequested,
          if: createWorkflowTriggerExpression(input.workflowId),
        },
      ],
      cancelOn: [
        {
          event: workflowRunCancelRequested,
          if: "async.data.executionId == event.data.executionId",
        },
      ],
    },
    async (context) =>
      await workflowRunRequestedHandler({ ...context, actions: input.actions })
  );
}
