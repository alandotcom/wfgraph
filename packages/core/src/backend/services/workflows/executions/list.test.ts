// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { WorkflowExecution } from "#src/backend/services/workflows/executions/repo/index";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { getWorkflowExecutions } from "#src/backend/services/workflows/executions/list";

function execution(id: string, status: WorkflowExecution["status"]) {
  return {
    id,
    workflowId: "wf_1",
    workflowRunId: null,
    status,
    startSource: "event" as const,
    runMode: "live" as const,
    triggerEventType: "app/appointment.created",
    correlationKey: "appt_1",
    input: null,
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    cancelRequestedAt: null,
    cancelEventName: null,
    cancelPayload: null,
  };
}

/** The two reads this service makes, with what each was asked recorded. */
function makeRepos(rows: WorkflowExecution[]) {
  const listCalls: Array<{ workflowId: string; includeSuperseded: boolean }> =
    [];

  return {
    listCalls,
    layer: Layer.mergeAll(
      SilentAppLoggerLayer,
      stubWorkflowRepo({ existsById: () => Effect.succeed(true) }),
      stubExecutionRepo({
        listByWorkflow: (input) =>
          Effect.sync(() => {
            listCalls.push(input);
            return rows;
          }),
        countSuperseded: () => Effect.succeed(3),
        listWorkflowEvents: () => Effect.succeed([]),
      })
    ),
  };
}

describe("getWorkflowExecutions", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // The count is answered whether or not the rows are: a builder deciding
    // whether to look at them needs the number first.
    it.effect("answers the count of superseded runs it left out", () =>
      Effect.gen(function* () {
        const repos = makeRepos([execution("exec_1", "completed")]);

        const result = yield* getWorkflowExecutions({
          workflowId: "wf_1",
          includeSuperseded: false,
        }).pipe(Effect.provide(repos.layer));

        assert.strictEqual(result.supersededCount, 3);
        assert.deepStrictEqual(
          result.items.map((item) => item.id),
          ["exec_1"]
        );
        assert.deepStrictEqual(repos.listCalls, [
          { workflowId: "wf_1", includeSuperseded: false },
        ]);
      })
    );

    it.effect("asks for the superseded rows when the toggle is on", () =>
      Effect.gen(function* () {
        const repos = makeRepos([execution("exec_1", "superseded")]);

        yield* getWorkflowExecutions({
          workflowId: "wf_1",
          includeSuperseded: true,
        }).pipe(Effect.provide(repos.layer));

        assert.deepStrictEqual(repos.listCalls, [
          { workflowId: "wf_1", includeSuperseded: true },
        ]);
      })
    );

    // Timestamps cross the wire as ISO strings, which is what the panel formats.
    it.effect("hands the timestamps over as strings", () =>
      Effect.gen(function* () {
        const repos = makeRepos([execution("exec_1", "completed")]);

        const result = yield* getWorkflowExecutions({
          workflowId: "wf_1",
          includeSuperseded: false,
        }).pipe(Effect.provide(repos.layer));

        assert.strictEqual(
          result.items[0]?.startedAt,
          "2026-03-01T10:00:00.000Z"
        );
      })
    );

    // The Refused Starts ride in this payload rather than in a procedure of their
    // own, so their mapping is asserted here: the panel formats a Date.
    it.effect("hands the Refused Starts over with their timestamps", () =>
      Effect.gen(function* () {
        const repos = Layer.mergeAll(
          SilentAppLoggerLayer,
          stubWorkflowRepo({ existsById: () => Effect.succeed(true) }),
          stubExecutionRepo({
            listByWorkflow: () => Effect.succeed([]),
            countSuperseded: () => Effect.succeed(0),
            listWorkflowEvents: () =>
              Effect.succeed([
                {
                  id: "evt_1",
                  workflowId: "wf_1",
                  executionId: null,
                  eventType: "run_not_started",
                  message: "Refused a start from event app/appointment.created",
                  metadata: { reason: "concurrency_first_wins" },
                  createdAt: new Date("2026-03-01T09:59:00.000Z"),
                },
              ]),
          })
        );

        const result = yield* getWorkflowExecutions({
          workflowId: "wf_1",
          includeSuperseded: false,
        }).pipe(Effect.provide(repos));

        assert.deepStrictEqual(result.refusedStarts, [
          {
            id: "evt_1",
            message: "Refused a start from event app/appointment.created",
            metadata: { reason: "concurrency_first_wins" },
            createdAt: "2026-03-01T09:59:00.000Z",
          },
        ]);
      })
    );

    it.effect("answers not-found for a workflow that is gone", () =>
      Effect.gen(function* () {
        const failure = yield* getWorkflowExecutions({
          workflowId: "wf_gone",
          includeSuperseded: false,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              stubWorkflowRepo({ existsById: () => Effect.succeed(false) }),
              stubExecutionRepo()
            )
          ),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "NotFound");
      })
    );
  });
});
