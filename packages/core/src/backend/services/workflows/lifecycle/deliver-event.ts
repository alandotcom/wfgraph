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
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";
import { resumeWaitsMatchingEvent } from "#src/backend/services/workflows/lifecycle/resume-waits";
import { runWorkflowExecutionPreflight } from "#src/backend/services/workflows/triggering/preflight";
import {
  type EventSubscriber,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";
import type { JsonObject } from "@rova/shared/types/json";
import { getValueByPath } from "@rova/shared/utils/object-path";
import {
  emptyLifecycleRules,
  type LifecycleRules,
  resolveCorrelationPath,
} from "@rova/shared/workflow/lifecycle-rules";
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
  /** This Event holds no start role here, so only its waits are owed anything. */
  | { kind: "waits_only"; workflowId: string }
  | {
      kind: "skipped";
      workflowId: string;
      reason: "workflow_gone" | "graph_unrunnable";
    };

/** What the wait half did, which is a count and nothing else. */
export type WaitDeliveryOutcome = {
  workflowId: string;
  resumedWaits: number;
};

/**
 * The Entity Value a payload carries for this workflow, trimmed.
 *
 * The path is the Event Author's, or the one the builder supplied for an Event
 * that declares none. Two Events describe one entity when these agree, whatever
 * paths they came from. Untrimmed, `" appt_1"` and `"appt_1"` would be two
 * entities and Concurrency would serialize neither against the other.
 */
function readEntityValue(input: {
  event: DeliveredEvent;
  rules: LifecycleRules;
  payload: JsonObject;
}): string | undefined {
  const path = resolveCorrelationPath({
    rules: input.rules,
    eventName: input.event.name,
    declaredPath: input.event.correlationPath,
  });
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
 * A cancel arm belongs beside the start arm and arrives with the Canceled outlet.
 * Until then a Cancel Event cannot be saved at all, so an Event reaching here
 * holds the start role or no role.
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

    const workflow = yield* repo.findById(input.subscriber.id);
    if (!workflow) {
      // The subscription rows cascade with the workflow, so this is a delete
      // landing between the index read and here.
      return skipped(input.subscriber.id, "workflow_gone");
    }

    // Preflight is the start branch's alone: it validates every action, condition
    // and integration reference in the graph, and a wait delivery needs none of
    // that. Its refusals are this workflow's problem rather than the Event's, so
    // they answer here instead of failing.
    const preflight = yield* runWorkflowExecutionPreflight({
      workflow,
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

    if (!rules.startEvents.includes(input.event.name)) {
      return { kind: "waits_only" as const, workflowId: workflow.id };
    }

    const started = yield* startWithConcurrency({
      workflow: {
        id: workflow.id,
        name: workflow.name,
        graph: preflight.workflowGraph,
      },
      concurrency: rules.concurrency,
      start: {
        source: "event",
        eventName: input.event.name,
        deliveryId: input.deliveryId,
        entityValue: readEntityValue({
          event: input.event,
          rules,
          payload: input.payload,
        }),
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
  const waitStates = yield* repo.listWaitsForEvent({
    workflowId: input.subscriber.id,
    eventName: input.event.name,
    runMode: input.subscriber.mode,
  });

  const candidates = waitStates.filter(
    (state) => !input.excluding.includes(state.executionId)
  );
  if (candidates.length === 0) {
    return nothing;
  }

  const resumedWaits = yield* resumeWaitsMatchingEvent({
    workflowId: input.subscriber.id,
    eventType: input.event.name,
    payload: input.payload,
    waitStates: candidates,
  });

  return { workflowId: input.subscriber.id, resumedWaits };
});

function skipped(
  workflowId: string,
  reason: "workflow_gone" | "graph_unrunnable"
): LifecycleDeliveryOutcome {
  return { kind: "skipped", workflowId, reason };
}
