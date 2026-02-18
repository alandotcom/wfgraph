import {
  executeWorkflow,
  type WorkflowExecutionInput,
  type WorkflowExecutionRuntime,
} from "@/backend/lib/workflow-executor.workflow";
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
    isOptionalString(value.executionId) &&
    isOptionalString(value.workflowId) &&
    isOptionalString(value.workflowName) &&
    isOptionalString(value.workflowRunId) &&
    (value.dryRun === undefined || typeof value.dryRun === "boolean") &&
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
  return getInngestClient().createFunction(
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
