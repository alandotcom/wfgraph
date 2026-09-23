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
  deliverWaitCandidates,
  listWaitCandidatePage,
  type WaitCandidatePage,
  type LifecycleDeliveryOutcome,
  listEventSubscribers,
} from "#src/backend/services/workflows/lifecycle/deliver-event";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { compileEventDataEquals } from "@wfgraph/shared/lifecycle/inngest-event-data";
import { toListenerFunctionId } from "#src/backend/lib/inngest/listener-function-id";
import { splitCatalogEventData } from "#src/backend/lib/inngest/catalog-connection";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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
  listWaitCandidates: typeof listWaitCandidatePage;
  deliverWaitCandidates: typeof deliverWaitCandidates;
};

export const defaultDeliverPorts: EventListenerDeliverPorts = {
  listSubscribers: listEventSubscribers,
  applyLifecycle: applyLifecycleRules,
  listWaitCandidates: listWaitCandidatePage,
  deliverWaitCandidates,
};

/**
 * One delivered Event, fanned out.
 *
 * Each workflow's Lifecycle Rules are a separate step from its waits, because a
 * wait delivery that fails must not replay a start. Wait candidates are saved in
 * bounded pages before any signal is sent. Each page's delivery is a sibling
 * durable step, so a retry uses the original rows and does not discover a later
 * sequential Wait the same arrival caused.
 */
export async function runEventListener(input: {
  event: AnyEventDefinition;
  payload: JsonObject;
  /** Names the arrival in every line and row this delivery writes. */
  arrival: { eventId?: string; runId?: string };
  /**
   * The Connection this arrival came through. Absent for a host Event.
   */
  connectionId?: string | undefined;
  runtime: WfGraphRuntime;
  step: EventListenerSteps;
  deliver: EventListenerDeliverPorts;
}): Promise<{ eventName: string; workflows: WorkflowDelivery[] }> {
  const { event, payload, runtime, step, deliver } = input;
  // The SDK always supplies runId, even when its optional Event id is absent.
  // Separate namespaces keep a host-chosen Event id from colliding with a run.
  const waitDeliveryId =
    input.arrival.eventId !== undefined
      ? `event:${input.arrival.eventId}`
      : input.arrival.runId !== undefined
        ? `run:${input.arrival.runId}`
        : undefined;
  const arrivalLogger = logger.with({
    eventName: event.name,
    ...input.arrival,
  });

  // The gate, because what arrives is a host's own message onto the bus rather
  // than a contract between Workflow Graph's two halves. A refusal is not
  // retried, because the same payload fails the same way on the next attempt.
  const decoded = await runtime.runPromise(
    event.decodePayloadValue(payload).pipe(
      Effect.match({
        onSuccess: (value) => ({ success: true as const, value }),
        onFailure: (rejection) => ({ success: false as const, rejection }),
      })
    )
  );
  if (!decoded.success) {
    const { rejection } = decoded;
    // The thrown sentence reaches Inngest's own run history, which a host can
    // read, so it takes the answer string; the log line takes the operator's.
    arrivalLogger.warn("Refused an event payload", { error: rejection.detail });
    throw new NonRetriableError(
      `Payload refused for Event "${event.name}": ${rejection.error}`
    );
  }

  const deliveredEvent = {
    name: event.name,
    correlationPath: event.correlationPath,
    connectionId: input.connectionId,
    entityBindings: event.entities,
    validatedPayload: decoded.value,
  };

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

    // The wait role is pushed from the parked-run read. A subscriber without it
    // cannot gain a wait role on retry because that list is memoized. For a
    // subscriber that does have it, the candidate pages below become the fixed
    // set this arrival can wake.
    let waits = { workflowId: subscriber.id, resumedWaits: 0 };
    if (subscriber.roles.includes("wait")) {
      const candidatePages: WaitCandidatePage[] = [];
      let afterId: string | undefined;

      // Collect every page before a delivery step can wake any run. Inngest
      // memoizes these step outputs when a later delivery page retries. Each
      // page consumes two steps; this scan remains subject to Inngest's
      // per-invocation step limit, including subscriber and lifecycle steps.
      for (let pageIndex = 0; ; pageIndex += 1) {
        // eslint-disable-next-line no-await-in-loop -- the next cursor depends on this durable page result.
        const page = await step.run(
          `wait-candidates-${subscriber.id}-${pageIndex}`,
          async () =>
            await runtime.runPromise(
              deliver.listWaitCandidates({
                workflowId: subscriber.id,
                eventName: deliveredEvent.name,
                afterId,
                excludingExecutionIds: excluding,
              })
            )
        );
        candidatePages.push(page);

        if (!page.hasMore) {
          break;
        }
        if (!page.afterId) {
          throw new Error("A full wait candidate page has no cursor");
        }
        afterId = page.afterId;
      }

      for (const [pageIndex, page] of candidatePages.entries()) {
        // eslint-disable-next-line no-await-in-loop -- page delivery steps are siblings and have stable, ordered ids.
        const pageOutcome = await step.run(
          `waits-${subscriber.id}-${pageIndex}`,
          async () =>
            await runtime.runPromise(
              deliver.deliverWaitCandidates({
                workflowId: subscriber.id,
                event: deliveredEvent,
                payload,
                candidates: page.candidates,
                deliveryId: waitDeliveryId,
              })
            )
        );
        waits = {
          workflowId: subscriber.id,
          resumedWaits: waits.resumedWaits + pageOutcome.resumedWaits,
        };
      }
    }

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
  /**
   * Whether `sendCatalogEvent` stamped `connectionId` onto this Event's data.
   * Host Events never stamp; a payload key of that name stays on the envelope.
   */
  connectionStamped: boolean;
}): InngestFunction.Any {
  const { client, event, runtime, connectionStamped } = input;
  const when = event.source.when;

  return client.createFunction(
    {
      ...event.inngestFunctionOptions,
      id: toListenerFunctionId(event.name),
      name: `Event listener: ${event.name}`,
      triggers: [
        omitUndefined({
          event: event.source.event,
          // An umbrella source pays no invocations for the subtypes this Event is
          // not, because Inngest evaluates the filter before calling us.
          if: when ? compileEventDataEquals(when) : undefined,
        }),
      ],
    },
    async ({ event: delivered, step, runId }) => {
      const { payload, connectionId } = splitCatalogEventData(
        toEventPayload(delivered.data),
        { connectionStamped }
      );
      return await runEventListener({
        event,
        payload,
        arrival: { eventId: delivered.id, runId },
        connectionId,
        runtime,
        step,
        deliver: defaultDeliverPorts,
      });
    }
  );
}
