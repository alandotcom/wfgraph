/**
 * The fan-out of one inbox row's delivery: which workflows the Event concerns,
 * each one's Lifecycle Rules, and the parked Waits it wakes. The delivery body
 * (`delivery-body.ts`) gates the payload and calls `runEventListener` with the
 * pass's step memo, so a step that committed is answered from its memo row
 * when the delivery runs again.
 */

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
import type { JsonObject } from "@wfgraph/shared/types/json";

const logger = getAppLogger("events");

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

/** What one workflow's delivery came to. */
type WorkflowDelivery = {
  lifecycle: LifecycleDeliveryOutcome;
  resumedWaits: number;
};

/**
 * The steps a delivery needs, named here rather than taken from the executor's
 * runtime, so the shape it depends on is stated in one readable place and a
 * test can stand in for it.
 */
export type EventListenerSteps = {
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
 *
 * The caller has already gated `payload` through the Event's schema, and
 * passes the decoded value as `validatedPayload`.
 */
export async function runEventListener(input: {
  event: AnyEventDefinition;
  payload: JsonObject;
  /** What `event.decodePayloadValue` answered for `payload`. */
  validatedPayload: unknown;
  /**
   * The inbox row being delivered. Its id is the delivery id both halves
   * write: the lifecycle's committed decision and every wake.
   */
  inboxId: string;
  /**
   * The Connection this arrival came through. Absent for a host Event.
   */
  connectionId?: string | undefined;
  runtime: WfGraphRuntime;
  step: EventListenerSteps;
  deliver: EventListenerDeliverPorts;
}): Promise<{ eventName: string; workflows: WorkflowDelivery[] }> {
  const { event, payload, runtime, step, deliver } = input;
  const { inboxId } = input;
  const arrivalLogger = logger.with({ eventName: event.name, inboxId });

  const deliveredEvent = {
    name: event.name,
    correlationPath: event.correlationPath,
    connectionId: input.connectionId,
    entityBindings: event.entities,
    validatedPayload: input.validatedPayload,
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
                deliveryId: inboxId,
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

      // Collect every page before a delivery step can wake any run. The step
      // memo answers these page reads when a later delivery page retries.
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
                deliveryId: inboxId,
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
