/**
 * One Event, delivered to one workflow, in the two halves Precedence names.
 *
 * The Lifecycle Rules apply first, then the Event reaches the Wait Subscriptions
 * of the runs that survived them (ADR-0007). There is no other ordering rule: a
 * start always starts, and Concurrency resolves multiplicity.
 *
 * The two halves are separate entry points because the listener runs each in its
 * own durable step: a wait delivery that fails then retries without replaying the
 * start, which would open a second run. Everything either half answers with is
 * JSON, because that is what crosses a step boundary.
 *
 * There is no whole-fan-out function here. The listener is the only fan-out, and
 * it owns the loop so that each workflow is its own retry unit.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { requestCanceledOutlet } from "#src/backend/services/workflows/lifecycle/cancel";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";
import { resumeWaitsMatchingEvent } from "#src/backend/services/workflows/lifecycle/resume-waits";
import { runWorkflowExecutionPreflight } from "#src/backend/services/executions/preflight";
import {
  type EventSubscriber,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";
import { toWorkflowRunTarget } from "#src/backend/services/executions/run-rows";
import type { JsonObject } from "@rova/shared/types/json";
import { getValueByPath } from "@rova/shared/utils/object-path";
import { emptyLifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
import { asNonEmptyString } from "@rova/shared/types/string";

/**
 * The Event as delivery reads it: its identity, and where its payload carries an
 * Entity Value.
 *
 * A definition holds a schema and a source too, and neither matters here. The
 * payload was gated at the channel it arrived on, and how it travelled stops
 * mattering once it has a name. Nothing brands this as gated, so a future
 * entrypoint could pass an ungated payload; the two that exist both gate.
 */
export type DeliveredEvent = {
  readonly name: string;
  readonly correlationPath?: string;
};

/** What the Lifecycle Rules did to one workflow, as the listener records it. */
export type LifecycleDeliveryOutcome =
  | {
      kind: "started";
      workflowId: string;
      executionId: string;
      supersededExecutionIds: string[];
      failedToSupersede: string[];
    }
  | {
      kind: "refused";
      workflowId: string;
      reason: "concurrency_first_wins" | "entity_value_missing";
    }
  /**
   * This Event holds the cancel role here; the ids are the runs it claimed. A
   * claimed run whose last node had already finished ends `completed`, since it
   * reaches no further boundary to read the flag at.
   */
  | {
      kind: "canceled";
      workflowId: string;
      canceledExecutionIds: string[];
    }
  /** This Event holds no start role here, so only its waits are owed anything. */
  | { kind: "waits_only"; workflowId: string }
  | {
      kind: "skipped";
      workflowId: string;
      reason: "workflow_gone" | "graph_unrunnable" | "not_published";
    };

/** What the wait half did, which is a count and nothing else. */
export type WaitDeliveryOutcome = {
  workflowId: string;
  resumedWaits: number;
};

/**
 * How many parked runs one read of the candidate set brings back. The whole set
 * is still walked; this is what keeps a workflow with thousands of parked runs
 * from materializing all of them, and their compiled matches, at once.
 */
const WAIT_CANDIDATE_PAGE_SIZE = 200;

/**
 * Where this workflow reads the Event's Entity Value.
 *
 * The builder's per-workflow path wins over the Event Author's declaration --
 * the same precedence `resolveCorrelationPath` states over the two paths a graph
 * carries -- and it comes off the subscription row rather than off the graph:
 * the row is written in the same transaction as the graph it was derived from,
 * which is what lets the index answer a delivery on its own.
 */
function correlationPathFor(input: {
  event: DeliveredEvent;
  subscriber: EventSubscriber;
}): string | undefined {
  return (
    input.subscriber.correlationPath ?? input.event.correlationPath ?? undefined
  );
}

/**
 * The Entity Value a payload carries for this workflow, trimmed.
 *
 * Two Events describe one entity when these agree, whatever paths they came
 * from. Untrimmed, `" appt_1"` and `"appt_1"` would be two entities and
 * Concurrency would serialize neither against the other.
 */
function readEntityValue(input: {
  event: DeliveredEvent;
  subscriber: EventSubscriber;
  payload: JsonObject;
}): string | undefined {
  const path = correlationPathFor(input);
  if (!path) {
    return undefined;
  }

  return asNonEmptyString(getValueByPath(input.payload, path));
}

/** The workflows this Event concerns, with the roles it holds in each. */
export const listEventSubscribers = Effect.fn("listEventSubscribers")(
  function* (eventName: string) {
    const repo = yield* WorkflowRepo;
    return yield* repo.listEventSubscribers(eventName);
  }
);

/**
 * The Lifecycle Rules, applied to one workflow.
 *
 * A workflow that is gone or holding a graph that will not run is answered rather
 * than failed: the Event has other workflows to reach, and a rejected query is the
 * only thing here worth retrying.
 *
 * The two arms below are exclusive: one Event holding both roles in one workflow
 * is what the save rules refuse, so an arrival either cancels here or starts.
 */
export const applyLifecycleRules = Effect.fn("applyLifecycleRules")(
  function* (input: {
    subscriber: EventSubscriber;
    event: DeliveredEvent;
    payload: JsonObject;
    /**
     * The arrival this delivery belongs to, which lands on the audit row so one
     * arrival can be traced across every workflow it reached.
     */
    deliveryId?: string;
  }) {
    const repo = yield* WorkflowRepo;
    const logger = (yield* AppLogger)
      .get("workflow", "deliver-event")
      .with({ eventName: input.event.name, workflowId: input.subscriber.id });

    const loaded = yield* repo.findByIdWithPublishedVersionForRun(
      input.subscriber.id
    );
    if (!loaded) {
      // The subscription rows cascade with the workflow, so this is a delete
      // landing between the index read and here.
      return skipped(input.subscriber.id, "workflow_gone");
    }

    const { workflow, publishedVersion: version } = loaded;
    if (!version) {
      return skipped(input.subscriber.id, "not_published");
    }

    // Preflight is the start branch's alone: it validates every action, condition
    // and integration reference in the graph, and a wait delivery needs none of
    // that. Its refusals are this workflow's problem rather than the Event's, so
    // they answer here instead of failing.
    const preflight = yield* runWorkflowExecutionPreflight({
      workflow: { graph: version.graph },
      workflowVersionId: version.id,
      catalogFingerprint: version.catalogFingerprint,
    }).pipe(
      Effect.catchTags({
        InvalidInput: (failure) =>
          logger
            .warn("Skipped a workflow whose graph will not run", {
              error: failure.error,
            })
            .pipe(Effect.as(undefined)),
        IntegrationValidationFailed: (failure) =>
          logger
            .warn("Skipped a workflow naming integrations it cannot use", {
              error: failure.error,
            })
            .pipe(Effect.as(undefined)),
      })
    );

    if (!preflight) {
      return skipped(input.subscriber.id, "graph_unrunnable");
    }

    // A graph carrying no rules starts on nothing, which is not the same as a
    // graph that cannot run: its parked runs still have Events owed to them.
    const rules = preflight.lifecycleRules ?? emptyLifecycleRules;

    const entityValue = readEntityValue({
      event: input.event,
      subscriber: input.subscriber,
      payload: input.payload,
    });

    if (rules.cancelEvents.includes(input.event.name)) {
      // A cancel matches by Entity Value and has nothing else to match on, so a
      // payload carrying none reaches no run. The save rules require a path for
      // every Cancel Event, which is what makes this the payload's own gap.
      //
      // The row is what a Refused Start gets for the same reason: without it the
      // builder watches the runs carry on and finds nothing anywhere saying the
      // cancel was refused.
      if (!entityValue) {
        const executionRepo = yield* ExecutionRepo;
        yield* executionRepo.recordAuditEvent({
          workflowId: workflow.id,
          eventType: "cancel_not_delivered",
          message: `Cancel from ${input.event.name} reached no run: nothing at this workflow's Correlation Path`,
          metadata: {
            reason: "entity_value_missing",
            eventName: input.event.name,
            correlationPath: correlationPathFor(input),
            deliveryId: input.deliveryId,
            runMode: workflow.mode,
          },
        });

        yield* logger.info("Cancel refused", {
          reason: "entity_value_missing",
          deliveryId: input.deliveryId,
        });

        return {
          kind: "refused" as const,
          workflowId: workflow.id,
          reason: "entity_value_missing" as const,
        };
      }

      const canceledExecutionIds = yield* requestCanceledOutlet({
        workflowId: workflow.id,
        runMode: workflow.mode,
        eventName: input.event.name,
        payload: input.payload,
        entityValue,
      });

      return {
        kind: "canceled" as const,
        workflowId: workflow.id,
        canceledExecutionIds,
      };
    }

    if (!rules.startEvents.includes(input.event.name)) {
      return { kind: "waits_only" as const, workflowId: workflow.id };
    }

    const started = yield* startWithConcurrency({
      workflow: toWorkflowRunTarget({
        workflow,
        versionId: version.id,
        catalogFingerprint: version.catalogFingerprint,
        graph: preflight.workflowGraph,
      }),
      concurrency: rules.concurrency,
      start: {
        source: "event",
        eventName: input.event.name,
        deliveryId: input.deliveryId,
        entityValue,
      },
      runMode: workflow.mode,
      payload: input.payload,
      logger,
    });

    if (started.status === "not_started") {
      return {
        kind: "refused" as const,
        workflowId: workflow.id,
        reason: started.reason,
      };
    }

    const outcome: LifecycleDeliveryOutcome = {
      kind: "started",
      workflowId: workflow.id,
      executionId: started.executionId,
      supersededExecutionIds: started.supersededExecutionIds,
      failedToSupersede: started.failedToSupersede,
    };
    return outcome;
  }
);

/**
 * The Event, offered to the runs of this workflow that are parked on it.
 *
 * `excluding` names the runs this delivery already settled: a superseded run is on
 * its way out and waking its wait would resume a run with no next step, and the
 * run just started has parked nothing yet.
 *
 * Candidates are found by Event name alone, and each row's own compiled match
 * decides whether the payload belongs to that run. Nothing here reads a
 * Correlation Path: a Wait Subscription states what it compares, so an Event with
 * no entity of its own still wakes exactly the runs that asked for it.
 */
export const deliverToWaits = Effect.fn("deliverToWaits")(function* (input: {
  subscriber: EventSubscriber;
  event: DeliveredEvent;
  payload: JsonObject;
  excluding: string[];
}) {
  const nothing: WaitDeliveryOutcome = {
    workflowId: input.subscriber.id,
    resumedWaits: 0,
  };

  const repo = yield* ExecutionRepo;

  let afterId: string | undefined;
  let resumedWaits = 0;

  // A page at a time, because nothing bounds how many runs are parked on one
  // Event: the wait timeout defaults to 7 days, and every candidate row carries
  // the JSONB holding its compiled match. Every page is still walked, so no run
  // owed this Event is skipped.
  for (;;) {
    const candidates = yield* repo.listWaitsForEvent({
      workflowId: input.subscriber.id,
      eventName: input.event.name,
      runMode: input.subscriber.mode,
      limit: WAIT_CANDIDATE_PAGE_SIZE,
      afterId,
      excludingExecutionIds: input.excluding,
    });

    if (candidates.length === 0) {
      break;
    }

    resumedWaits += yield* resumeWaitsMatchingEvent({
      workflowId: input.subscriber.id,
      eventType: input.event.name,
      payload: input.payload,
      waitStates: candidates,
    });

    if (candidates.length < WAIT_CANDIDATE_PAGE_SIZE) {
      break;
    }

    afterId = candidates.at(-1)?.id;
  }

  if (resumedWaits === 0) {
    return nothing;
  }

  return { workflowId: input.subscriber.id, resumedWaits };
});

function skipped(
  workflowId: string,
  reason: "workflow_gone" | "graph_unrunnable" | "not_published"
): LifecycleDeliveryOutcome {
  return { kind: "skipped", workflowId, reason };
}
