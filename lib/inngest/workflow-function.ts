import {
  executeWorkflow,
  type WorkflowExecutionInput,
  type WorkflowExecutionRuntime,
} from "../workflow-executor.workflow";
import { inngest } from "./client";

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

export const workflowRunRequestedFunction = inngest.createFunction(
  {
    id: "workflow-run-requested",
    cancelOn: [
      {
        event: "workflow/run.cancel.requested",
        if: "async.data.executionId == event.data.executionId",
      },
    ],
  },
  {
    event: "workflow/run.requested",
  },
  async ({ event, step }) => {
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
);
