import type { Inngest } from "inngest";
import type { JsonObject } from "@rova/shared/types/json";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";
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

/**
 * Put a host's own Event on the bus, which is what HTTP intake does with a
 * posted payload: the Event's listener is then the only fan-out, and the
 * durability is Inngest's rather than the request's.
 *
 * `deliveryId` becomes the event id, so the 202 the sender read, the log line,
 * and every audit row the listener writes all name the same arrival. It is also
 * Inngest's idempotency key, which here dedupes a retried send of one delivery
 * rather than two posts: each POST mints its own.
 */
export async function sendHostEvent(
  client: Inngest,
  input: {
    name: string;
    data: JsonObject;
    deliveryId: string;
  }
) {
  await client.send({
    name: input.name,
    data: input.data,
    id: input.deliveryId,
  });
}

export async function sendWorkflowCancelRequested(
  client: Inngest,
  input: {
    executionId: string;
    workflowId: string;
    reason: string;
    requestedBy: string;
    eventType?: string;
    correlationKey?: string;
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
    correlationKey?: string;
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
