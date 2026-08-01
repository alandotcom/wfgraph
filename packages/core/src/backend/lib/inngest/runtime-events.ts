import type { Inngest } from "inngest";
import type { JsonObject } from "@rova/shared/types/json";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";
import {
  workflowRunCancelRequested,
  workflowRunRequested,
  workflowWaitSignal,
} from "#src/backend/lib/inngest/events";

export type WorkflowRunRequestedEventData = {
  graph: SerializedWorkflowGraph;
  /**
   * The payload that set the run going. Inngest stringifies event data before
   * sending it, so anything here that is not JSON is lost in transit; the type
   * says so.
   */
  startPayload?: JsonObject;
  /** The Event that started the run, absent where a person or the route did. */
  startEventName?: string;
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
};

/**
 * Each of these passes an `id`, which is Inngest's idempotency key: a duplicate
 * send under the same id triggers no second run. That is what keeps a retried
 * enqueue from starting the workflow twice.
 */
export async function sendWorkflowRunRequested(
  client: Inngest,
  data: WorkflowRunRequestedEventData
) {
  const { ids } = await client.send(
    workflowRunRequested.create(data, {
      id: `workflow-run-${data.executionId}`,
    })
  );

  return { eventId: ids[0] };
}

export async function sendWorkflowCancelRequested(
  client: Inngest,
  input: {
    executionId: string;
    workflowId: string;
    reason: string;
    requestedBy: string;
    eventType?: string;
    entityValue?: string;
  }
) {
  return await client.send(
    workflowRunCancelRequested.create(input, {
      id: `workflow-cancel-${input.executionId}-${Date.now()}`,
    })
  );
}

export async function sendWorkflowWaitSignal(
  client: Inngest,
  input: {
    executionId: string;
    nodeId: string;
    token?: string | null;
    eventType?: string;
    entityValue?: string;
    // JSON is what survives the send, so the caller supplies JSON.
    payload?: JsonObject;
    /** Why the run is being woken; the wait's `if` expression admits both. */
    signalType: "wait-resume" | "lifecycle-cancel";
  }
) {
  return await client.send(
    workflowWaitSignal.create(input, {
      id: `workflow-wait-signal-${input.executionId}-${input.nodeId}-${Date.now()}`,
    })
  );
}
