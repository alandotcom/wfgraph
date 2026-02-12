import {
  executeWorkflow,
  type WorkflowExecutionInput,
  type WorkflowExecutionRuntime,
} from "@/backend/lib/workflow-executor.workflow";
import { inngest } from "./client";

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

function escapeInngestExpressionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  };
}) {
  const data = event.data as WorkflowExecutionInput;
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
          options.timeoutMs !== undefined
            ? toDurationString(options.timeoutMs)
            : "365d",
      }),
  };

  return await executeWorkflow(data, runtime);
}

export function createWorkflowRunRequestedFunction(input: {
  id: string;
  name?: string;
  workflowId: string;
}) {
  return inngest.createFunction(
    {
      id: input.id,
      name: input.name,
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
