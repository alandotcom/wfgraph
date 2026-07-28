import type { JsonObject } from "@rova/shared/types/json";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";
import { getInngestClient } from "./client";
import {
  workflowRunCancelRequested,
  workflowRunRequested,
  workflowWaitSignal,
} from "./events";

export type WorkflowRunRequestedEventData = {
  graph: SerializedWorkflowGraph;
  /**
   * The payload that set the run going. Inngest stringifies event data before
   * sending it, so anything here that is not JSON is lost in transit; the type
   * says so.
   */
  triggerInput?: JsonObject;
  workflowName?: string;
  requestPayload?: JsonObject;
  /**
   * Every producer inserts the execution row before enqueueing, and the engine
   * requires the id, so it is never optional on the wire.
   */
  executionId: string;
  workflowId: string;
  workflowRunId?: string;
  runMode?: "live" | "test";
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

/**
 * Each of these passes an `id`, which is Inngest's idempotency key: a duplicate
 * send under the same id triggers no second run. That is what keeps a retried
 * enqueue from starting the workflow twice.
 */
export async function sendWorkflowRunRequested(
  data: WorkflowRunRequestedEventData
) {
  const { ids } = await getInngestClient().send(
    workflowRunRequested.create(data, {
      id: `workflow-run-${data.executionId}`,
    })
  );

  return { eventId: ids[0] };
}

export async function sendWorkflowCancelRequested(input: {
  executionId: string;
  workflowId: string;
  reason: string;
  requestedBy: string;
  eventType?: string;
  correlationKey?: string;
}) {
  return await getInngestClient().send(
    workflowRunCancelRequested.create(input, {
      id: `workflow-cancel-${input.executionId}-${Date.now()}`,
    })
  );
}

export async function sendWorkflowWaitSignal(input: {
  executionId: string;
  nodeId: string;
  token?: string | null;
  eventType?: string;
  correlationKey?: string;
  // JSON is what survives the send, so the caller supplies JSON.
  payload?: JsonObject;
}) {
  return await getInngestClient().send(
    workflowWaitSignal.create(
      { ...input, signalType: "wait-resume" },
      {
        id: `workflow-wait-signal-${input.executionId}-${input.nodeId}-${Date.now()}`,
      }
    )
  );
}
