import { assert, describe, expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type {
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/workflows/executions/repo/index";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import {
  buildIgnoredRunAuditMessage,
  buildRunStartedAuditMessage,
  enqueueStartedRun,
  recordPausedRunIgnored,
} from "./run-lifecycle";

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowRunId: null,
    status: "running",
    startSource: "event",
    runMode: "live",
    triggerEventType: null,
    correlationKey: null,
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T00:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    ...overrides,
  };
}

const runTarget = {
  id: "wf_1",
  name: "Appointment Reminders",
  graph: { nodes: [], edges: [] },
};

describe("buildRunStartedAuditMessage", () => {
  it("names the start source that opened the run", () => {
    expect(
      buildRunStartedAuditMessage({ startSource: "manual", runMode: "live" })
    ).toBe("Manual run started");
    expect(
      buildRunStartedAuditMessage({ startSource: "schedule", runMode: "live" })
    ).toBe("Scheduled run started");
    expect(
      buildRunStartedAuditMessage({ startSource: "event", runMode: "live" })
    ).toBe("Event-triggered run started");
  });

  it("marks test mode runs", () => {
    expect(
      buildRunStartedAuditMessage({ startSource: "event", runMode: "test" })
    ).toBe("Event-triggered test mode run started");
  });

  it("appends the Event that started the run", () => {
    expect(
      buildRunStartedAuditMessage({
        startSource: "event",
        runMode: "test",
        eventName: "app/appointment.created",
      })
    ).toBe("Event-triggered test mode run started for app/appointment.created");
  });
});

describe("buildIgnoredRunAuditMessage", () => {
  it("uses the calling start source's own vocabulary", () => {
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "manual",
        reason: "workflow_paused",
      })
    ).toBe("Ignored manual run because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "event",
        reason: "workflow_paused",
      })
    ).toBe("Ignored event because workflow is paused");
  });

  // The refusal is the whole point of the row: without it, first-wins
  // Concurrency declining a start is invisible.
  it("says which Event first-wins Concurrency declined", () => {
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "event",
        reason: "concurrency_first_wins",
        eventName: "app/appointment.created",
      })
    ).toBe(
      "Refused a start from event app/appointment.created: a run for this entity is already going and Concurrency is first-wins"
    );
    expect(
      buildIgnoredRunAuditMessage({
        startSource: "manual",
        reason: "concurrency_first_wins",
      })
    ).toBe(
      "Refused a start from manual run: a run for this entity is already going and Concurrency is first-wins"
    );
  });
});

// The two blocks below take their `it` from the `layer` callback, typed with the
// services that layer provides. The message builders above need no services and
// use the plain one imported at the top, so the callback parameter is named
// apart from it rather than shadowing it.
describe("enqueueStartedRun", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    serviceIt.effect("stores the event id the enqueue answered with", () =>
      Effect.gen(function* () {
        const calls = {
          runIds: [] as Array<{ executionId: string; runId: string | null }>,
        };

        // The row is opened by `ExecutionRepo.startForEntity`, under the lock that
        // makes Concurrency a decision; this is what happens after it exists.
        // `markEnqueueFailed` is left refusing, so a compensation on the happy
        // path would kill the test rather than pass unnoticed.
        const started = yield* enqueueStartedRun({
          workflow: runTarget,
          start: { source: "event" },
          executionId: "exec_1",
          runMode: "live",
          payload: { order: "o1" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                setRunId: (input) =>
                  Effect.sync(() => {
                    calls.runIds.push(input);
                  }),
                recordAuditEvent: () => Effect.void,
              }),
              stubInngestClient({
                sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
              })
            )
          )
        );

        assert.deepStrictEqual(started, {
          executionId: "exec_1",
          runId: "evt_1",
          runMode: "live",
        });
        assert.deepStrictEqual(calls.runIds, [
          { executionId: "exec_1", runId: "evt_1" },
        ]);
      })
    );

    // The row is closed before the failure travels on, so a run is never left
    // sitting in "running" with nothing behind it that could finish it.
    serviceIt.effect("closes the row when the enqueue is refused", () =>
      Effect.gen(function* () {
        const calls = {
          closed: [] as Array<{ executionId: string; error: string }>,
        };

        // `setRunId` is left refusing: there is no run id to store, and writing
        // one would be the bug.
        const failure = yield* enqueueStartedRun({
          workflow: runTarget,
          start: { source: "event" },
          executionId: "exec_1",
          runMode: "live",
          payload: {},
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                markEnqueueFailed: (input) =>
                  Effect.sync(() => {
                    calls.closed.push(input);
                    return true;
                  }),
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.fail(
                    new InngestError({
                      cause: new Error("inngest dev server unreachable"),
                    })
                  ),
              })
            )
          ),
          Effect.flip
        );

        assert.instanceOf(failure, InngestError);
        assert.deepStrictEqual(calls.closed, [
          { executionId: "exec_1", error: "inngest dev server unreachable" },
        ]);
      })
    );

    serviceIt.effect(
      "falls back to a fixed sentence when nothing was thrown",
      () =>
        Effect.gen(function* () {
          const calls = {
            closed: [] as Array<{ executionId: string; error: string }>,
          };

          yield* enqueueStartedRun({
            workflow: runTarget,
            start: { source: "event" },
            executionId: "exec_1",
            runMode: "live",
            payload: {},
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubExecutionRepo({
                  markEnqueueFailed: (input) =>
                    Effect.sync(() => {
                      calls.closed.push(input);
                      return true;
                    }),
                }),
                stubInngestClient({
                  sendRunRequested: () =>
                    Effect.fail(new InngestError({ cause: "connection lost" })),
                })
              )
            ),
            Effect.flip
          );

          assert.deepStrictEqual(calls.closed, [
            { executionId: "exec_1", error: "Failed to enqueue run" },
          ]);
        })
    );

    // A refused send is ambiguous: Inngest may have taken the event and failed
    // on the way back, in which case the run is already executing and reached a
    // verdict the compensation may not overwrite. The line is how an operator
    // learns that is what happened.
    serviceIt.effect("says so when the run got to a verdict first", () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();

        yield* enqueueStartedRun({
          workflow: runTarget,
          start: { source: "event" },
          executionId: "exec_1",
          runMode: "live",
          payload: {},
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                markEnqueueFailed: () => Effect.succeed(false),
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.fail(
                    new InngestError({ cause: new Error("gateway timeout") })
                  ),
              }),
              recorder.layer
            )
          ),
          Effect.flip
        );

        assert.deepStrictEqual(recorder.infoLines, [
          {
            message:
              "Enqueue reported failure but the run had already left the in-flight statuses",
            properties: { executionId: "exec_1" },
          },
        ]);
      })
    );
  });
});

describe("recordPausedRunIgnored", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    // The runs list is the only feedback the manual and webhook entrypoints
    // give, so a paused workflow's request gets a row saying it was declined
    // rather than no row at all.
    serviceIt.effect("writes a terminal row carrying the reason", () =>
      Effect.gen(function* () {
        const calls = {
          terminals: [] as Array<
            Parameters<ExecutionRepo["Service"]["insertTerminal"]>[0]
          >,
        };

        const execution = yield* recordPausedRunIgnored({
          workflowId: "wf_1",
          startSource: "event",
          runMode: "test",
          payload: { order: "o1" },
        }).pipe(
          Effect.provide(
            stubExecutionRepo({
              insertTerminal: (input) =>
                Effect.sync(() => {
                  calls.terminals.push(input);
                  return createExecution({
                    id: "exec_ignored",
                    status: "completed",
                  });
                }),
              recordAuditEvent: () => Effect.void,
            })
          )
        );

        assert.strictEqual(execution.id, "exec_ignored");

        const recorded = calls.terminals[0];
        assert.isDefined(recorded);
        assert.strictEqual(recorded.status, "completed");
        assert.strictEqual(recorded.startSource, "event");
        assert.strictEqual(recorded.runMode, "test");
        assert.deepStrictEqual(recorded.output, {
          status: "ignored",
          reason: "workflow_paused",
          runMode: "test",
        });
      })
    );
  });
});
