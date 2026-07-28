import { assert, describe, expect, it, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { vi } from "vitest";
import { Effect, Layer } from "effect";
import type {
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/workflows/executions/repo";
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
  recordPausedRunIgnored,
  startWorkflowRun,
} from "./run-lifecycle";

// Both entrypoints below write a timeline entry through the audit module, which
// holds its own database handle. The rows are not what these tests are about, so
// the module is replaced for this file; vitest scopes a mock to the file that
// declares it.
vi.mock("#src/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: () => Promise.resolve(undefined),
}));

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowRunId: null,
    status: "running",
    triggerType: "webhook",
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
  it("names the entrypoint that started the run", () => {
    expect(
      buildRunStartedAuditMessage({ triggerType: "manual", runMode: "live" })
    ).toBe("Manual run started");
    expect(
      buildRunStartedAuditMessage({ triggerType: "webhook", runMode: "live" })
    ).toBe("Webhook run started");
    expect(
      buildRunStartedAuditMessage({ triggerType: "event", runMode: "live" })
    ).toBe("Event-triggered run started");
  });

  it("marks test mode runs", () => {
    expect(
      buildRunStartedAuditMessage({ triggerType: "webhook", runMode: "test" })
    ).toBe("Webhook test mode run started");
  });

  it("appends the event type when the trigger resolved one", () => {
    expect(
      buildRunStartedAuditMessage({
        triggerType: "event",
        runMode: "test",
        eventType: "order.created",
      })
    ).toBe("Event-triggered test mode run started for order.created");
  });
});

describe("buildIgnoredRunAuditMessage", () => {
  it("uses the calling entrypoint's own vocabulary", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "manual",
        reason: "workflow_paused",
      })
    ).toBe("Ignored execute event because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "workflow_paused",
      })
    ).toBe("Ignored webhook event because workflow is paused");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "event",
        reason: "workflow_paused",
      })
    ).toBe("Ignored event because workflow is paused");
  });

  it("reports where the event type was expected", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "missing_event_type",
        eventTypePath: "body.type",
      })
    ).toBe('Ignored webhook event: event type missing at path "body.type"');
  });

  // No path is fabricated when none is known: a default would send the
  // builder to fix a field the classifier never reads.
  it("omits the path when none is configured", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "missing_event_type",
      })
    ).toBe("Ignored webhook event: no event type was found in the payload");
  });

  it("says the payload failed the trigger schema", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "invalid_payload",
      })
    ).toBe("Ignored webhook event: payload failed the trigger schema");
  });

  it("names the event the routing policy does not map", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_mapped",
        eventType: "order.archived",
      })
    ).toBe(
      "Ignored webhook event order.archived: not mapped by the routing policy"
    );
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "event_not_mapped",
      })
    ).toBe("Ignored webhook event: not mapped by the routing policy");
  });

  it("explains that a cancel event found nothing to cancel", () => {
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "webhook",
        reason: "no_in_flight_runs",
        eventType: "order.cancelled",
      })
    ).toBe("Ignored order.cancelled because no in-flight runs were found");
    expect(
      buildIgnoredRunAuditMessage({
        triggerType: "manual",
        reason: "no_in_flight_runs",
      })
    ).toBe("Ignored execute event because no in-flight runs were found");
  });
});

// The two blocks below take their `it` from the `layer` callback, typed with the
// services that layer provides. The message builders above need no services and
// use the plain one imported at the top, so the callback parameter is named
// apart from it rather than shadowing it.
describe("startWorkflowRun", () => {
  layer(SilentAppLoggerLayer)((serviceIt) => {
    serviceIt.effect("stores the event id the enqueue answered with", () =>
      Effect.gen(function* () {
        const calls = {
          runIds: [] as Array<{ executionId: string; runId: string | null }>,
        };

        // `markEnqueueFailed` is left refusing, so a compensation on the happy
        // path would kill the test rather than pass unnoticed.
        const started = yield* startWorkflowRun({
          workflow: runTarget,
          trigger: { type: "webhook" },
          runMode: "live",
          payload: { order: "o1" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                insertRunning: () => Effect.succeed(createExecution()),
                setRunId: (input) =>
                  Effect.sync(() => {
                    calls.runIds.push(input);
                  }),
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
        const failure = yield* startWorkflowRun({
          workflow: runTarget,
          trigger: { type: "webhook" },
          runMode: "live",
          payload: {},
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                insertRunning: () => Effect.succeed(createExecution()),
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

          yield* startWorkflowRun({
            workflow: runTarget,
            trigger: { type: "webhook" },
            runMode: "live",
            payload: {},
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubExecutionRepo({
                  insertRunning: () => Effect.succeed(createExecution()),
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

        yield* startWorkflowRun({
          workflow: runTarget,
          trigger: { type: "webhook" },
          runMode: "live",
          payload: {},
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                insertRunning: () => Effect.succeed(createExecution()),
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
          triggerType: "webhook",
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
                    status: "success",
                  });
                }),
            })
          )
        );

        assert.strictEqual(execution.id, "exec_ignored");

        const recorded = calls.terminals[0];
        assert.isDefined(recorded);
        assert.strictEqual(recorded.status, "success");
        assert.strictEqual(recorded.triggerType, "webhook");
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
