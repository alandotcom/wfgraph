import type { SerializedWorkflowGraph } from "@/shared/workflow/types";
import { getInngestClient } from "./client";

export type WorkflowRunRequestedEventData = {
  graph: SerializedWorkflowGraph;
  triggerInput?: Record<string, unknown>;
  workflowName?: string;
  requestPayload?: Record<string, unknown>;
  executionId?: string;
  workflowId: string;
  workflowRunId?: string;
  dryRun?: boolean;
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

type SendResult =
  | {
      eventId?: string;
      ids?: string[];
      id?: string;
      eventIds?: string[];
    }
  | Array<{
      eventId?: string;
      ids?: string[];
      id?: string;
      eventIds?: string[];
    }>;

function getEventId(result: unknown): string | undefined {
  if (!result) {
    return;
  }

  if (Array.isArray(result)) {
    return getEventId(result[0]);
  }

  if (typeof result !== "object") {
    return;
  }

  const typed = result as SendResult;
  if ("eventId" in typed && typeof typed.eventId === "string") {
    return typed.eventId;
  }
  if ("id" in typed && typeof typed.id === "string") {
    return typed.id;
  }
  if (
    "eventIds" in typed &&
    Array.isArray(typed.eventIds) &&
    typeof typed.eventIds[0] === "string"
  ) {
    return typed.eventIds[0];
  }
  if (
    "ids" in typed &&
    Array.isArray(typed.ids) &&
    typeof typed.ids[0] === "string"
  ) {
    return typed.ids[0];
  }

  return;
}

export async function sendWorkflowRunRequested(
  data: WorkflowRunRequestedEventData
) {
  const response = await getInngestClient().send({
    id: data.executionId ? `workflow-run-${data.executionId}` : undefined,
    name: "workflow/run.requested",
    data,
  });

  return { eventId: getEventId(response) };
}

export async function sendWorkflowCancelRequested(input: {
  executionId: string;
  workflowId: string;
  reason: string;
  requestedBy: string;
  eventType?: string;
  correlationKey?: string;
}) {
  return await getInngestClient().send({
    id: `workflow-cancel-${input.executionId}-${Date.now()}`,
    name: "workflow/run.cancel.requested",
    data: input,
  });
}

export async function sendWorkflowWaitSignal(input: {
  executionId: string;
  nodeId: string;
  token?: string | null;
  eventType?: string;
  correlationKey?: string;
  payload?: Record<string, unknown>;
}) {
  return await getInngestClient().send({
    id: `workflow-wait-signal-${input.executionId}-${input.nodeId}-${Date.now()}`,
    name: "workflow/wait.signal",
    data: {
      ...input,
      signalType: "wait-resume",
    },
  });
}
