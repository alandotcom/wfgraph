// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionSummary,
  ExecutionTerminationState,
  ExecutorState,
  WorkflowExecutionLog,
} from "#src/backend/services/executions/repo";
import { getExecutionLogs } from "#src/backend/services/executions/logs";

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowVersionId: "ver_1",
    versionKind: "published",
    versionNumber: 1,
    status: "completed",
    startSource: "event",
    runMode: "live",
    startEventName: "app/appointment.created",
    entityValue: "appt_1",
    entityType: null,
    entityId: null,
    input: null,
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    completedAt: new Date("2026-03-01T10:00:01.000Z"),
    duration: "1000",
    ...overrides,
  };
}

/** The three reads this service makes, with the summary the test chose. */
function makeRepos(
  execution: ExecutionSummary | null,
  logs: WorkflowExecutionLog[] = [],
  termination: ExecutionTerminationState | null = null
) {
  return Layer.mergeAll(
    SilentAppLoggerLayer,
    stubExecutionRepo({
      findSummaryById: () => Effect.succeed(execution),
      findTerminationState: () => Effect.succeed(termination),
      listLogs: () => Effect.succeed(logs),
      listWaitingStates: () => Effect.succeed([]),
    })
  );
}

describe("getExecutionLogs", () => {
  layer(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      makeAppContextLayer({ apiBasePath: "/api" })
    )
  )((it) => {
    // The graph itself rides `getVersionGraph` now (#37); this payload still
    // has to carry the version id that procedure is keyed by, or the client
    // has nothing to fetch the graph with.
    it.effect("carries the pinned version id the graph is fetched by", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(makeRepos(summary({ workflowVersionId: "ver_9" })))
        );

        assert.strictEqual(result.execution.workflowVersionId, "ver_9");
      })
    );

    // Start identity rides in the same thinner summary so a past-cap deep link
    // can still label Test Mode / event / entity without a list row.
    it.effect("hands start identity through on the execution summary", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(
            makeRepos(
              summary({
                runMode: "test",
                startSource: "event",
                startEventName: "order.updated",
                entityValue: "ord_2",
              })
            )
          )
        );

        assert.strictEqual(result.execution.runMode, "test");
        assert.strictEqual(result.execution.startSource, "event");
        assert.strictEqual(result.execution.startEventName, "order.updated");
        assert.strictEqual(result.execution.entityValue, "ord_2");
      })
    );

    it.effect(
      "returns the stored Exit boundary without Entity ID or State",
      () =>
        Effect.gen(function* () {
          const result = yield* getExecutionLogs("exec_1").pipe(
            Effect.provide(
              makeRepos(
                summary({
                  status: "exited",
                  entityType: "patient",
                  entityId: "patient_secret",
                }),
                [],
                {
                  executionId: "exec_1",
                  status: "exited",
                  claim: {
                    kind: "exit",
                    requestedAt: new Date("2026-03-01T10:00:05.000Z"),
                    reason: "entity_condition_not_met",
                    nodeId: "send-reminder",
                  },
                  didWrite: false,
                }
              )
            )
          );

          assert.deepStrictEqual(result.exit, {
            reason: "entity_condition_not_met",
            entityType: "patient",
            nodeId: "send-reminder",
            checkedAt: "2026-03-01T10:00:05.000Z",
          });
          assert.notInclude(JSON.stringify(result.exit), "patient_secret");
        })
    );

    it.effect("redacts execution input and output beside the node logs", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(
            makeRepos(
              summary({
                input: { password: "input-secret" },
                output: { apiToken: "output-secret" },
              })
            )
          )
        );

        assert.deepStrictEqual(result.execution.input, {
          password: "********cret",
        });
        assert.deepStrictEqual(result.execution.output, {
          apiToken: "********cret",
        });
      })
    );

    it.effect("redacts credentials embedded in execution and node errors", () =>
      Effect.gen(function* () {
        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(
            makeRepos(summary({ error: "token=execution-secret" }), [
              {
                id: "log_1",
                executionId: "exec_1",
                nodeId: "node_1",
                nodeName: "Send request",
                nodeType: "action",
                status: "error",
                input: null,
                output: null,
                error: "Authorization: Bearer node-secret",
                startedAt: new Date("2026-03-01T10:00:00.000Z"),
                completedAt: new Date("2026-03-01T10:00:01.000Z"),
                duration: "1000",
                timestamp: new Date("2026-03-01T10:00:00.000Z"),
                retries: 0,
              },
            ])
          )
        );

        assert.notInclude(result.execution.error ?? "", "execution-secret");
        assert.notInclude(result.logs[0]?.error ?? "", "node-secret");
      })
    );

    // A run the executor holds answers where it stands, with every instant an
    // ISO string and the server's clock beside them; an ended run answers null
    // without asking.
    it.effect("answers an in-progress run's executor state", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-03-01T10:05:00.000Z"));
        const state: ExecutorState = {
          state: "queued",
          wakeAt: new Date("2026-03-01T10:06:00.000Z"),
          attempt: 0,
          runningStepId: null,
          runningNodeId: null,
          runningNodeName: null,
          leaseExpiresAt: null,
          workerId: null,
          lastError: "token=step-secret",
          failingSteps: [
            {
              stepId: "node:send:dispatch",
              nodeId: "send",
              nodeName: "Send reminder",
              failures: 2,
              error: "Authorization: Bearer step-secret",
            },
          ],
          unconsumedWakes: [
            {
              waitStateId: "wait_1",
              nodeId: "approval",
              nodeName: "Approval",
              kind: "resume",
              eventName: "app/approved",
              wokenAt: new Date("2026-03-01T10:04:00.000Z"),
              deadline: null,
            },
          ],
        };
        const reposFor = (held: ExecutorState) =>
          Layer.mergeAll(
            SilentAppLoggerLayer,
            makeAppContextLayer({ apiBasePath: "/api" }),
            stubExecutionRepo({
              findSummaryById: () =>
                Effect.succeed(
                  summary({ status: "running", completedAt: null })
                ),
              findTerminationState: () => Effect.succeed(null),
              listLogs: () => Effect.succeed([]),
              listWaitingStates: () => Effect.succeed([]),
              findExecutorState: () => Effect.succeed(held),
            })
          );

        const result = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(reposFor(state))
        );
        // Once a pass has read the wake, the same run is retrying its failing
        // step, and the activity carries the step's error redacted.
        const retrying = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(reposFor({ ...state, unconsumedWakes: [] }))
        );
        assert.deepStrictEqual(retrying.schedule?.activity, {
          kind: "retrying",
          nodeId: "send",
          nodeName: "Send reminder",
          nextTryAt: "2026-03-01T10:06:00.000Z",
          failures: 2,
          retryLimit: 4,
          error: "Authorization: [REDACTED]",
        });

        assert.deepStrictEqual(result.schedule, {
          observedAt: "2026-03-01T10:05:00.000Z",
          overdueAfterMs: 60_000,
          activity: {
            kind: "resuming",
            nodeId: "approval",
            nodeName: "Approval",
            wake: "resume",
            eventName: "app/approved",
            wokenAt: "2026-03-01T10:04:00.000Z",
            deadline: null,
            unclaimedSince: "2026-03-01T10:04:00.000Z",
          },
          state: "queued",
          wakeAt: "2026-03-01T10:06:00.000Z",
          attempt: 0,
          retryLimit: 4,
          runningStepId: null,
          leaseExpiresAt: null,
          workerId: null,
          // The run is resuming, not waiting out a retry, so no step has a
          // next try time.
          failingSteps: [
            {
              nodeId: "send",
              failures: 2,
              error: "Authorization: [REDACTED]",
              nextTryAt: null,
            },
          ],
        });
        // While the run waits out its retry, every failing step's next try is
        // the run's next pass.
        assert.deepStrictEqual(
          retrying.schedule?.failingSteps.map((step) => step.nextTryAt),
          ["2026-03-01T10:06:00.000Z"]
        );

        const ended = yield* getExecutionLogs("exec_1").pipe(
          Effect.provide(makeRepos(summary()))
        );
        assert.strictEqual(ended.schedule, null);
      })
    );

    it.effect("answers not-found when the run is gone", () =>
      Effect.gen(function* () {
        const failure = yield* getExecutionLogs("exec_gone").pipe(
          Effect.provide(makeRepos(null)),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "NotFound");
      })
    );
  });
});
