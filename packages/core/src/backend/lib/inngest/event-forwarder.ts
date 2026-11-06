/**
 * One Inngest function per name a host sends Events under, whose body sends
 * the Inngest event into the event inbox through `events.send`, the same call
 * `app.events.send` is. A host on Inngest keeps calling `inngest.send`, and
 * the worker loop delivers the inbox row as it does for every other source.
 *
 * The name is an Event's `source.event`, which is the Event's own name unless
 * the Event arrives on an umbrella source. Several Events sharing a source
 * share its forwarder, and `send` tells which Event an arrival is by each
 * one's `source.when`.
 */

import { NonRetriableError, type Inngest, type InngestFunction } from "inngest";
import { toForwarderFunctionId } from "#src/backend/lib/inngest/forwarder-function-id";
import {
  WfGraphEventRefused,
  type WfGraphEventReceipt,
  type WfGraphEvents,
} from "#src/backend/host-events";
import { readJsonObject } from "@wfgraph/shared/types/json";

/**
 * Sends one Inngest event into the inbox under `name`, keyed by the event's
 * id. Inngest's server gives every event an id, using its own when the sender
 * set none, and an invocation Inngest retries reads the same stored event, so
 * a retried send is answered with the first one's inbox row.
 *
 * Data that is not a JSON object carries no fields for an Event schema to
 * describe, so it is sent as an empty payload, which the Event's schema then
 * refuses. A refused send throws `NonRetriableError`, because the same event
 * would be refused on every attempt. A storage failure rethrows as it is, so
 * Inngest retries the step.
 */
async function forwardToInbox(input: {
  name: string;
  event: { id?: string | undefined; data?: unknown };
  events: WfGraphEvents;
}): Promise<WfGraphEventReceipt> {
  try {
    return await input.events.send({
      name: input.name,
      data: readJsonObject(input.event.data) ?? {},
      id: input.event.id,
    });
  } catch (error) {
    if (error instanceof WfGraphEventRefused) {
      throw new NonRetriableError(error.message, { cause: error });
    }
    throw error;
  }
}

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal.
export function createInngestEventForwarder(input: {
  /** The host's Inngest client, which this forwarder is created on. */
  client: Inngest;
  /** The Inngest event name this forwarder triggers on and sends under. */
  name: string;
  /** The app's or runner's `events`, whose inbox the event is sent into. */
  events: WfGraphEvents;
}): InngestFunction.Any {
  const { client, name, events } = input;

  return client.createFunction(
    {
      id: toForwarderFunctionId(name),
      name: `Forward to the event inbox: ${name}`,
      triggers: [{ event: name }],
    },
    async ({ event, step }) =>
      // One step, so an invocation Inngest retries after the send committed
      // is answered from the step's memo rather than sending again.
      await step.run(
        "forward-to-inbox",
        async () => await forwardToInbox({ name, event, events })
      )
  );
}
