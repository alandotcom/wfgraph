import type { Inngest } from "inngest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  workflowBranchKillRequested,
  workflowRunCancelRequested,
  workflowRunRequested,
  workflowWaitSignal,
} from "#src/backend/lib/inngest/events";

export type WorkflowRunRequestedEventData = {
  /**
   * Every producer inserts the execution row before enqueueing, and the engine
   * requires the id, so it is never optional on the wire.
   */
  executionId: string;
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

/**
 * Kills one run's branch invocations, leaving the run itself alive.
 *
 * Carries a timestamp for the same reason the cancel above does: a second
 * request against a run whose earlier one did not take must not be deduplicated
 * away.
 */
export async function sendWorkflowBranchKill(
  client: Inngest,
  input: {
    executionId: string;
    workflowId: string;
    reason: string;
  }
) {
  return await client.send(
    workflowBranchKillRequested.create(input, {
      id: `workflow-branch-kill-${input.executionId}-${Date.now()}`,
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

/**
 * Forward a catalog Event onto the bus, including the Connection it arrived
 * through as Inngest `user` rather than payload.
 *
 * `user.connectionId` is first-class delivery metadata: listeners read it
 * beside the Event name, and CEL exposes it as `event.connectionId`. The
 * payload stays the vendor envelope.
 */
export async function sendCatalogEvent(
  client: Inngest,
  input: {
    name: string;
    data: JsonObject;
    connectionId: string;
    id?: string;
  }
) {
  const event = {
    name: input.name,
    data: input.data,
    user: { connectionId: input.connectionId },
    ...(input.id === undefined ? {} : { id: input.id }),
  };
  return await client.send(event);
}
