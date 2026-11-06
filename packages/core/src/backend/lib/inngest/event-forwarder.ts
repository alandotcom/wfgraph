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

import { Cause, Effect, Exit } from "effect";
import type { Inngest, InngestFunction } from "inngest";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import type { WfGraphRuntime } from "#src/backend/runtime";
import {
  DriverError,
  ExecutionDriver,
} from "#src/backend/services/executions/driver";
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

const forwardLogger = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("events")
);

/**
 * What a failed forward carries to the log and to Inngest: the storage
 * failure under a `DriverError`, which the database layer has already cleared
 * of the query's bound values, or the defect itself.
 */
function forwardFailure(cause: Cause.Cause<DriverError>): unknown {
  const squashed = Cause.squash(cause);
  return squashed instanceof DriverError ? squashed.cause : squashed;
}

/**
 * Records one Inngest event in the inbox under `name`, keyed by the event's
 * id, and wakes the worker loops once a new row has committed. A second event
 * with the same id, or a retried invocation, is answered with the first row
 * and wakes nothing. Inngest's server gives every event an id, using its own
 * when the sender set none, and an invocation Inngest retries reads the same
 * stored event, so the key is stable across retries. A failure writes one log
 * record naming the Event and whether it carried a key, and nothing of its
 * data.
 */
const forwardInngestEvent = Effect.fn("wfgraph.event.forward")(
  function* (input: {
    name: string;
    event: { id?: string | undefined; data?: unknown };
  }) {
    const driver = yield* ExecutionDriver;
    return yield* driver.receiveEvent({
      name: input.name,
      data: toEventPayload(input.event.data),
      connectionId: null,
      idempotencyKey: input.event.id ?? null,
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Effect.flatMap(forwardLogger, (logger) =>
          logger.error("Failed to record an Inngest event in the event inbox", {
            event: { name: input.name, keyed: input.event.id !== undefined },
            error: forwardFailure(cause),
          })
        )
      )
    )
);

/**
 * Runs `forwardInngestEvent` on the app's runtime. A failure rejects with one
 * `Error` whose `cause` is what `forwardFailure` answers, so Inngest records a
 * sentence and the cleared storage error.
 */
async function recordInInbox(input: {
  name: string;
  event: { id?: string | undefined; data?: unknown };
  runtime: WfGraphRuntime;
}): Promise<{ inboxId: string; duplicate: boolean }> {
  const exit = await input.runtime.runPromiseExit(
    forwardInngestEvent({ name: input.name, event: input.event })
  );
  if (Exit.isSuccess(exit)) {
    return { inboxId: exit.value.inboxId, duplicate: exit.value.duplicate };
  }
  throw new Error("Could not record the Inngest event in the event inbox", {
    cause: forwardFailure(exit.cause),
  });
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
        async () => await recordInInbox({ name, event, runtime })
      )
  );
}
