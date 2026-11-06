/**
 * One Inngest function per name a host sends Events under, whose body records
 * the Inngest event in the event inbox. A host on Inngest keeps calling
 * `inngest.send`, and the executor's delivery body delivers the inbox row the
 * forwarder wrote, as it does for every other source.
 *
 * The name is an Event's `source.event`, which is the Event's own name unless
 * the Event arrives on an umbrella source. Several Events sharing a source share
 * its forwarder, which records the event under the source name, and the
 * delivery body tells which Event it is by each one's `source.when`.
 */

import { Effect } from "effect";
import type { Inngest, InngestFunction } from "inngest";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { toForwarderFunctionId } from "#src/backend/lib/inngest/forwarder-function-id";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";

/**
 * Reads the payload off an Inngest event.
 *
 * Inngest serializes event data with `JSON.stringify` before sending it, so
 * whatever the host passed to `inngest.send(...)` reaches the forwarder as
 * JSON. Data that is not a JSON object carries no fields for an Event schema to
 * describe, so it is recorded as an empty payload, which the delivery body's
 * gate refuses.
 */
function toEventPayload(value: unknown): JsonObject {
  return readJsonObject(value) ?? {};
}

/**
 * Records one Inngest event in the inbox under `name`, keyed by the event's id,
 * and wakes the worker loops once a new row has committed. A second event with
 * the same id, or a retried invocation, is answered with the first row and
 * wakes nothing. An event that reaches the forwarder with no id is recorded
 * with no key, so only the step's memo keeps a retried invocation from
 * recording it twice.
 */
export function forwardInngestEvent(input: {
  name: string;
  event: { id?: string | undefined; data?: unknown };
  runtime: WfGraphRuntime;
}): Promise<{ inboxId: string; duplicate: boolean }> {
  const { name, event, runtime } = input;
  return runtime.runPromise(
    Effect.gen(function* () {
      const driver = yield* ExecutionDriver;
      return yield* driver.receiveEvent({
        name,
        data: toEventPayload(event.data),
        connectionId: null,
        idempotencyKey: event.id ?? null,
      });
    })
  );
}

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal. `InngestFunction.Any` is
// what the function registry collects these into anyway.
export function createInngestEventForwarder(input: {
  /** The app's own connection, which this forwarder is registered on. */
  client: Inngest;
  /** The Inngest event name this forwarder triggers on and records under. */
  name: string;
  /**
   * The app's Layer graph, handed in by `createWfGraphApp` through the
   * function registry, so the forwarder writes through the same driver and
   * repositories the HTTP side does.
   */
  runtime: WfGraphRuntime;
}): InngestFunction.Any {
  const { client, name, runtime } = input;

  return client.createFunction(
    {
      id: toForwarderFunctionId(name),
      name: `Forward to the event inbox: ${name}`,
      triggers: [{ event: name }],
    },
    async ({ event, step }) =>
      // One step, so an invocation Inngest retries after the write committed
      // is answered from the step's memo rather than writing again.
      await step.run(
        "forward-to-inbox",
        async () => await forwardInngestEvent({ name, event, runtime })
      )
  );
}
