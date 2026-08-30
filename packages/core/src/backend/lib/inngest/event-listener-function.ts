/**
 * One Inngest function per Event, built from the catalog.
 *
 * The listener set is the app's extension surface rather than its saved graphs, so
 * it is fixed for the life of the process: nothing a Workflow Builder does changes
 * which Events Inngest delivers, and a graph save needs no re-sync to keep it
 * current. Which workflows a delivered Event concerns is the subscription index's
 * question, asked inside the handler.
 *
 * Per Event rather than per source name, even though several Events may share a
 * source. A function then knows which Event it is without inspecting the payload,
 * its own flow control is the function's, and Inngest's ten-trigger ceiling is out
 * of reach. The narrowing stays Inngest's own: each function's single trigger
 * carries that Event's compiled `source.when`.
 */

import { Effect } from "effect";
import { NonRetriableError } from "inngest";
import type { Inngest, InngestFunction } from "inngest";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import { getAppLogger } from "#src/backend/lib/logger";
import type { WfGraphRuntime } from "#src/backend/runtime";
import {
  applyLifecycleRules,
  deliverToWaits,
  type LifecycleDeliveryOutcome,
  listEventSubscribers,
} from "#src/backend/services/workflows/lifecycle/deliver-event";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";
import { compileEventDataEquals } from "@wfgraph/shared/lifecycle/inngest-event-data";

const logger = getAppLogger("events");

/**
 * Reads the payload off an Inngest event.
 *
 * Inngest serializes event data with `JSON.stringify` before sending it, so
 * whatever the application passed to `inngest.send(...)` reaches us as JSON. This
 * parse is where that fact becomes a type. Data that is not a JSON object carries
 * no fields for an Event schema to describe, so it is treated as an empty payload
 * and refused by that schema.
 */
function toEventPayload(value: unknown): JsonObject {
  return readJsonObject(value) ?? {};
}

function connectionIdOf(delivered: { user?: unknown }): string | undefined {
  const user = delivered.user;
  if (typeof user !== "object" || user === null) {
    return undefined;
  }
  const connectionId = Reflect.get(user, "connectionId");
  return typeof connectionId === "string" && connectionId.length > 0
    ? connectionId
    : undefined;
}

/** The runs the Lifecycle Rules settled, which the wait half then leaves alone. */
function settledExecutionIds(outcome: LifecycleDeliveryOutcome): string[] {
  if (outcome.kind === "started") {
    return [outcome.executionId, ...outcome.supersededExecutionIds];
  }
  if (outcome.kind === "canceled") {
    return outcome.canceledExecutionIds;
  }
  return [];
}

/** What one workflow's delivery came to, as the function answers Inngest. */
type WorkflowDelivery = {
  lifecycle: LifecycleDeliveryOutcome;
  resumedWaits: number;
};

/**
 * The steps this handler needs, named here rather than taken from the SDK's
 * context, so the shape it depends on is stated in one readable place and a test
 * can stand in for it.
 */
type EventListenerSteps = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
};

/**
 * The deliver halves this listener fans out through.
 *
 * Named here so a wiring test can stand in for them without mocking the module
 * graph. Production wiring passes the real exports at the construction site.
 */
export type EventListenerDeliverPorts = {
  listSubscribers: typeof listEventSubscribers;
  applyLifecycle: typeof applyLifecycleRules;
  deliverWaits: typeof deliverToWaits;
};

export const defaultDeliverPorts: EventListenerDeliverPorts = {
  listSubscribers: listEventSubscribers,
  applyLifecycle: applyLifecycleRules,
  deliverWaits: deliverToWaits,
};

/**
 * One delivered Event, fanned out.
 *
 * Each workflow is two sibling steps: the Lifecycle Rules, then the wait delivery
 * that follows from what they did. Sibling rather than nested, because a wait
 * delivery that fails must not replay a start -- replaying one would open a second
 * run for the same arrival. The ids are derived from the workflow, and the
 * subscriber list is memoized above them, so a retry resumes at the workflow that
 * failed with the same list it started from.
 */
export async function runEventListener(input: {
  event: AnyEventDefinition;
  payload: JsonObject;
  /** Names the arrival in every line and row this delivery writes. */
  arrival: { eventId?: string; runId?: string };
  /**
   * The Connection this arrival came through. Absent for a host Event.
   */
  connectionId?: string;
  runtime: WfGraphRuntime;
  step: EventListenerSteps;
  deliver: EventListenerDeliverPorts;
}): Promise<{ eventName: string; workflows: WorkflowDelivery[] }> {
  const { event, payload, runtime, step, deliver } = input;
  const deliveredEvent = {
    name: event.name,
    correlationPath: event.correlationPath,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  };
  const arrivalLogger = logger.with({
    eventName: event.name,
    ...input.arrival,
  });

  // The gate, because what arrives is a host's own message onto the bus rather
  // than a contract between Workflow Graph's two halves. A refusal is not
  // retried, because the same payload fails the same way on the next attempt.
  const rejection = await runtime.runPromise(
    event.decodePayload(payload).pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (rejected) => rejected,
      })
    )
  );
  if (rejection) {
    // The thrown sentence reaches Inngest's own run history, which a host can
    // read, so it takes the answer string; the log line takes the operator's.
    arrivalLogger.warn("Refused an event payload", { error: rejection.detail });
    throw new NonRetriableError(
      `Payload refused for Event "${event.name}": ${rejection.error}`
    );
  }

  const subscribers = await step.run(
    `subscribers-${event.name}`,
    async () => await runtime.runPromise(deliver.listSubscribers(event.name))
  );

  const workflows: WorkflowDelivery[] = [];

  for (const subscriber of subscribers) {
    // The role says this workflow named the Event as a start or a cancel somewhere
    // in the graph it holds now; the rules read inside the step decide whether it
    // still does. Both checks are wanted: this one keeps a wait-only delivery off
    // the graph column, and that one is what either role is actually held to.
    const lifecycle: LifecycleDeliveryOutcome = subscriber.roles.some(
      (role) => role === "start" || role === "cancel"
    )
      ? // eslint-disable-next-line no-await-in-loop -- one workflow at a time: each is its own retry unit.
        await step.run(
          `lifecycle-${subscriber.id}`,
          async () =>
            await runtime.runPromise(
              deliver.applyLifecycle({
                subscriber,
                event: deliveredEvent,
                payload,
                // Inngest's id for this arrival, which is the sender's own
                // idempotency id wherever they sent one.
                deliveryId: input.arrival.eventId,
              })
            )
        )
      : { kind: "waits_only", workflowId: subscriber.id };

    if (lifecycle.kind === "skipped" && lifecycle.reason === "workflow_gone") {
      workflows.push({ lifecycle, resumedWaits: 0 });
      continue;
    }

    // A run this delivery just settled takes no wait: a superseded or claimed run
    // is ending, and the run just started has parked nothing yet.
    const excluding = settledExecutionIds(lifecycle);

    // The wait role is pushed only from the parked-run read, so a subscriber
    // without it had nothing waiting on this Event when the list was built and
    // the delivery would resolve to zero runs. A run parking between that step
    // and this one is outside this arrival's window either way: the subscriber
    // list is memoized, so a replay reads the same list it did the first time.
    const waits = subscriber.roles.includes("wait")
      ? // eslint-disable-next-line no-await-in-loop -- sibling of the step above, and sequential for the same reason.
        await step.run(
          `waits-${subscriber.id}`,
          async () =>
            await runtime.runPromise(
              deliver.deliverWaits({
                subscriber,
                event: deliveredEvent,
                payload,
                excluding,
              })
            )
        )
      : { workflowId: subscriber.id, resumedWaits: 0 };

    arrivalLogger.info("Delivered an event to a workflow", {
      workflowId: subscriber.id,
      roles: subscriber.roles,
      outcome: lifecycle.kind,
      // A refusal and a skip each name themselves, so the arrival's own line is
      // enough to tell a builder's mistake from a payload's gap.
      reason: "reason" in lifecycle ? lifecycle.reason : undefined,
      resumedWaits: waits.resumedWaits,
    });

    workflows.push({ lifecycle, resumedWaits: waits.resumedWaits });
  }

  arrivalLogger.info("Delivered an event", {
    workflows: workflows.length,
    started: workflows.filter((entry) => entry.lifecycle.kind === "started")
      .length,
  });

  return { eventName: event.name, workflows };
}

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal (`SendSignalResponse` under
// inngest/api). `InngestFunction.Any` is what the function registry collects
// these into anyway.
export function createInngestEventListenerFunction(input: {
  /** The app's own connection, which this listener is registered on. */
  client: Inngest;
  event: AnyEventDefinition;
  /**
   * The app's Layer graph. It arrives from `createWfGraphApp` through the function
   * registry rather than being reached for here, so this function runs its
   * services on the same repositories and logger the HTTP side does.
   */
  runtime: WfGraphRuntime;
}): InngestFunction.Any {
  const { client, event, runtime } = input;
  const when = event.source.when;

  return client.createFunction(
    {
      ...event.inngestFunctionOptions,
      id: toListenerFunctionId(event.name),
      name: `Event listener: ${event.name}`,
      triggers: [
        {
          event: event.source.event,
          // An umbrella source pays no invocations for the subtypes this Event is
          // not, because Inngest evaluates the filter before calling us.
          ...(when ? { if: compileEventDataEquals(when) } : {}),
        },
      ],
    },
    async ({ event: delivered, step, runId }) =>
      await runEventListener({
        event,
        payload: toEventPayload(delivered.data),
        arrival: { eventId: delivered.id, runId },
        connectionId: connectionIdOf(delivered),
        runtime,
        step,
        deliver: defaultDeliverPorts,
      })
  );
}
