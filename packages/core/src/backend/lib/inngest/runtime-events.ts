import type { Inngest } from "inngest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { withCatalogConnection } from "#src/backend/lib/inngest/catalog-connection";
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
    eventType?: string | undefined;
    entityValue?: string | undefined;
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
    token?: string | null | undefined;
    eventType?: string | undefined;
    entityValue?: string | undefined;
    // JSON is what survives the send, so the caller supplies JSON.
    payload?: JsonObject | undefined;
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
 * Forward a catalog Event onto the bus, carrying the Connection it arrived
 * through as an extra key on `data`.
 *
 * Inngest v4 dropped `event.user`: it is not stored and does not survive
 * replay. The vendor envelope stays the rest of `data` (`type`, `created_at`,
 * nested `data`, …) so `source.when` and Correlation Paths keep addressing it.
 * The listener strips the stamp before decode and delivery, so Wait CEL and
 * templates see the envelope the vendor posted.
 *
 * The idempotency id is namespaced by Connection, because the vendor's own id
 * is unique per message and not per endpoint. Two Connections subscribed to the
 * same vendor account receive one message under one id, and passing it through
 * raw would make Inngest read the second Connection's send as a duplicate and
 * drop it. Namespacing keeps a retry to one Connection deduplicated.
 */
export async function sendCatalogEvent(
  client: Inngest,
  input: {
    name: string;
    data: JsonObject;
    connectionId: string;
    id?: string | undefined;
  }
) {
  const event = omitUndefined({
    name: input.name,
    data: withCatalogConnection(input.data, input.connectionId),
    id:
      input.id === undefined
        ? undefined
        : `${input.name}-${input.connectionId}-${input.id}`,
  });
  return await client.send(event);
}
