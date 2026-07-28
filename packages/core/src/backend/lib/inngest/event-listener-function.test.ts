// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Workflow } from "#src/backend/lib/db/schema";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { runEventTrigger } from "#src/backend/lib/inngest/event-listener-function";

/**
 * A workflow whose graph has no root trigger, which is the cheapest way to fail
 * preflight before it reaches the integration rows it would otherwise query.
 */
const unrunnableWorkflow: Workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  description: null,
  graph: { nodes: [], edges: [] },
  isPaused: false,
  mode: "live",
  visibility: "private",
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
};

/**
 * Everything a delivered event may reach beyond the workflow row.
 *
 * All three cases below stop before a run is opened, and the refusals are what
 * say so: this listener asks for them statically because its body can start a
 * run, so they have to be provided even where they are never touched.
 */
const unreachableRunSeams = Layer.mergeAll(
  stubExecutionRepo(),
  stubInngestClient()
);

const delivery = {
  workflowId: "wf_1",
  eventLabel: "order.created",
  eventNames: ["order.created"],
  eventName: "order.created",
  payload: { id: "o1" },
};

/**
 * Which failures Inngest is allowed to retry.
 *
 * A throw puts the event back in front of the retry policy and a return value
 * does not, so where the boundary sits is the whole of what these pin. A
 * workflow that is gone and a graph that will not validate are no better on a
 * second attempt, so both come back as values. A refused query is a different
 * thing entirely, and converting it to a refusal would drop the event silently.
 */
describe("runEventTrigger", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("refuses a workflow that is no longer there", () =>
      Effect.gen(function* () {
        const outcome = yield* runEventTrigger(delivery).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({ findById: () => Effect.succeed(null) }),
              unreachableRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          status: "error",
          reason: "workflow_not_found",
        });
      })
    );

    it.effect("refuses a workflow whose graph will not validate", () =>
      Effect.gen(function* () {
        const outcome = yield* runEventTrigger(delivery).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findById: () => Effect.succeed(unrunnableWorkflow),
              }),
              unreachableRunSeams
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          status: "error",
          reason: "preflight_failed",
        });
      })
    );

    it.effect("leaves a refused query failing, so the event is retried", () =>
      Effect.gen(function* () {
        const failure = yield* runEventTrigger(delivery).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findById: () =>
                  Effect.fail(
                    new DatabaseError({
                      cause: new Error("terminating connection due to crash"),
                    })
                  ),
              }),
              unreachableRunSeams
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, DatabaseError);
      })
    );
  });
});
