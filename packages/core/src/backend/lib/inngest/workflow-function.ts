import {
  executeWorkflow,
  type WorkflowExecutionInput,
} from "@/backend/lib/workflow-engine/core";
import { dbWorkflowStore } from "@/backend/lib/workflow-engine/db-store";
import type { WorkflowExecutionRuntime } from "@/backend/lib/workflow-engine/runtime";
import { isSerializedWorkflowGraph } from "@/shared/workflow/graph";
import { getInngestClient } from "./client";

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

function escapeInngestExpressionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalRecord(
  value: unknown
): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
}

function isValidEventContext(
  value: unknown
): value is WorkflowExecutionInput["eventContext"] {
  if (value === undefined) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalString(value.eventType) && isOptionalString(value.correlationKey)
  );
}

function isWorkflowExecutionInput(
  value: unknown
): value is WorkflowExecutionInput {
  if (!(isRecord(value) && isSerializedWorkflowGraph(value.graph))) {
    return false;
  }

  return (
    isOptionalRecord(value.triggerInput) &&
    isOptionalRecord(value.requestPayload) &&
    // Both ids are required: every log row, timeline event, and wait state the
    // run writes hangs off them, and the enqueue side always supplies them.
    typeof value.executionId === "string" &&
    typeof value.workflowId === "string" &&
    isOptionalString(value.workflowName) &&
    isOptionalString(value.workflowRunId) &&
    (value.runMode === undefined ||
      value.runMode === "live" ||
      value.runMode === "test") &&
    isValidEventContext(value.eventContext)
  );
}

export function createWorkflowTriggerExpression(workflowId: string): string {
  return `event.data.workflowId == "${escapeInngestExpressionString(workflowId)}"`;
}

async function workflowRunRequestedHandler({
  event,
  step,
}: {
  event: { data: unknown };
  step: {
    sleep: (id: string, durationMs: number) => Promise<void>;
    waitForEvent: (
      id: string,
      options: { event: string; if?: string; timeout: string }
    ) => Promise<unknown>;
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  };
}) {
  if (!isWorkflowExecutionInput(event.data)) {
    throw new Error("Invalid workflow execution payload.");
  }

  const data = event.data;
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
  // nothing on its own, so the Postgres-backed store is wired in here.
  const result = await executeWorkflow(data, runtime, dbWorkflowStore);
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

export function createWorkflowRunRequestedFunction(input: {
  id: string;
  name?: string;
  workflowId: string;
}) {
  return getInngestClient().createFunction(
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
      cancelOn: [
        {
          event: "workflow/run.cancel.requested",
          if: "async.data.executionId == event.data.executionId",
        },
      ],
    },
    {
      event: "workflow/run.requested",
      if: createWorkflowTriggerExpression(input.workflowId),
    },
    workflowRunRequestedHandler
  );
}
