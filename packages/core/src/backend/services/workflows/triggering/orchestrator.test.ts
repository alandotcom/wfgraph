import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  orchestrateTriggerExecution,
  type TriggerWaitState,
} from "./orchestrator";

function createWaitState(
  id: string,
  executionId: string,
  waitForEvents?: string[]
): TriggerWaitState {
  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    hookToken: `token_${id}`,
    metadata: waitForEvents ? { waitForEvents } : null,
  };
}

type CancellationSummary = {
  cancelledExecutions: number;
  cancelledWaits: number;
  failedExecutions?: string[];
};

/**
 * The three things the orchestrator can ask for, each recording that it was
 * asked and in what order relative to the others.
 *
 * Every case supplies all three, and each test overrides the ones it asserts
 * on, so an unexpected call shows up as a count assertion rather than a crash.
 * Built per test rather than reset between them, so no test can see the calls
 * another one made.
 */
function makeCallbacks(overrides?: {
  startExecution?: () => {
    executionId: string;
    runId?: string;
    runMode: "live" | "test";
  };
  cancelInFlightRuns?: () => CancellationSummary;
  resumedCount?: number;
}) {
  const calls = {
    started: 0,
    cancelled: [] as Array<string | undefined>,
    resumed: 0,
    order: [] as string[],
  };

  return {
    calls,
    startExecution: () =>
      Effect.sync(() => {
        calls.started += 1;
        calls.order.push("start");
        return (
          overrides?.startExecution?.() ?? {
            executionId: "exec_started",
            runId: "run_started",
            runMode: "live" as const,
          }
        );
      }),
    cancelInFlightRuns: (eventType?: string) =>
      Effect.sync(() => {
        calls.cancelled.push(eventType);
        calls.order.push("cancel");
        return (
          overrides?.cancelInFlightRuns?.() ?? {
            cancelledExecutions: 0,
            cancelledWaits: 0,
          }
        );
      }),
    resumeWaitStates: () =>
      Effect.sync(() => {
        calls.resumed += 1;
        return overrides?.resumedCount ?? 0;
      }),
  };
}

describe("orchestrateTriggerExecution", () => {
  it.effect("ignores an invalid payload without attempting resumes", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 1 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: undefined,
          correlationKey: undefined,
          action: "ignore",
          ignoreReason: "invalid_payload",
        },
        inFlightExecutionIds: [],
        waitStates: [createWaitState("1", "exec_wait_1")],
        ...callbacks,
      });

      assert.deepStrictEqual(result, {
        status: "ignored",
        runMode: "live",
        reason: "invalid_payload",
      });
      assert.strictEqual(callbacks.calls.resumed, 0);
      assert.strictEqual(callbacks.calls.started, 0);
    })
  );

  it.effect(
    "ignores a payload with no event type without attempting resumes",
    () =>
      Effect.gen(function* () {
        const callbacks = makeCallbacks({ resumedCount: 1 });

        const result = yield* orchestrateTriggerExecution({
          runMode: "live",
          routing: {
            eventType: undefined,
            correlationKey: "abc",
            action: "ignore",
            ignoreReason: "missing_event_type",
          },
          inFlightExecutionIds: [],
          waitStates: [createWaitState("1", "exec_wait_1")],
          ...callbacks,
        });

        assert.deepStrictEqual(result, {
          status: "ignored",
          runMode: "live",
          reason: "missing_event_type",
        });
        assert.strictEqual(callbacks.calls.resumed, 0);
      })
  );

  it.effect("starts a fresh run when replace finds nothing in flight", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks();

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.rescheduled",
          correlationKey: "abc",
          action: "replace",
        },
        inFlightExecutionIds: [],
        waitStates: [],
        ...callbacks,
      });

      assert.deepStrictEqual(callbacks.calls.cancelled, []);
      assert.strictEqual(callbacks.calls.started, 1);
      assert.deepStrictEqual(result, {
        status: "running",
        executionId: "exec_started",
        runId: "run_started",
        runMode: "live",
      });
    })
  );

  it.effect("cancels the in-flight runs before starting the replacement", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({
        startExecution: () => ({
          executionId: "exec_replacement",
          runId: "run_replacement",
          runMode: "test" as const,
        }),
        cancelInFlightRuns: () => ({
          cancelledExecutions: 2,
          cancelledWaits: 3,
        }),
      });

      const result = yield* orchestrateTriggerExecution({
        runMode: "test",
        routing: {
          eventType: "appointment.rescheduled",
          correlationKey: "abc",
          action: "replace",
        },
        // One running execution parked at no wait node, one waiting.
        inFlightExecutionIds: ["exec_running", "exec_wait_1"],
        waitStates: [createWaitState("1", "exec_wait_1")],
        ...callbacks,
      });

      assert.deepStrictEqual(callbacks.calls.order, ["cancel", "start"]);
      assert.deepStrictEqual(callbacks.calls.cancelled, [
        "appointment.rescheduled",
      ]);
      // The wait state listens for any event, and the replace still wins.
      assert.strictEqual(callbacks.calls.resumed, 0);
      assert.deepStrictEqual(result, {
        status: "running",
        executionId: "exec_replacement",
        runId: "run_replacement",
        runMode: "test",
        cancelledExecutions: 2,
        cancelledWaits: 3,
      });
    })
  );

  it.effect("cancels every in-flight run for a cancel action", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({
        cancelInFlightRuns: () => ({
          cancelledExecutions: 2,
          cancelledWaits: 1,
          failedExecutions: ["exec_failed"],
        }),
        resumedCount: 1,
      });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.cancelled",
          correlationKey: "abc",
          action: "cancel",
        },
        // An execution with no wait state still gets cancelled.
        inFlightExecutionIds: ["exec_running", "exec_wait_1"],
        waitStates: [
          createWaitState("1", "exec_wait_1", ["appointment.cancelled"]),
        ],
        ...callbacks,
      });

      assert.lengthOf(callbacks.calls.cancelled, 1);
      // The policy wins over the wait: the run is cancelled, never resumed.
      assert.strictEqual(callbacks.calls.resumed, 0);
      assert.strictEqual(callbacks.calls.started, 0);
      assert.deepStrictEqual(result, {
        status: "cancelled",
        runMode: "live",
        cancelledExecutions: 2,
        cancelledWaits: 1,
        failedExecutions: ["exec_failed"],
      });
    })
  );

  it.effect("ignores a cancel action that finds nothing in flight", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks();

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.cancelled",
          correlationKey: "abc",
          action: "cancel",
        },
        inFlightExecutionIds: [],
        waitStates: [],
        ...callbacks,
      });

      assert.deepStrictEqual(callbacks.calls.cancelled, []);
      assert.deepStrictEqual(result, {
        status: "ignored",
        runMode: "live",
        reason: "no_in_flight_runs",
      });
    })
  );

  it.effect("resumes the wait states listening for this event type", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 1 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "test",
        routing: {
          eventType: "appointment.confirmed",
          correlationKey: "abc",
          action: "ignore",
          ignoreReason: "event_not_mapped",
        },
        inFlightExecutionIds: ["exec_wait_1", "exec_wait_2"],
        waitStates: [
          createWaitState("1", "exec_wait_1", [
            "appointment.confirmed",
            "appointment.cancelled",
          ]),
          createWaitState("2", "exec_wait_2", ["appointment.rescheduled"]),
        ],
        ...callbacks,
      });

      assert.strictEqual(callbacks.calls.resumed, 1);
      assert.strictEqual(callbacks.calls.started, 0);
      assert.deepStrictEqual(result, {
        status: "resumed",
        resumedCount: 1,
        runMode: "test",
      });
    })
  );

  it.effect("resumes a wait state whose waitForEvents list is empty", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 1 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "anything.happened",
          correlationKey: "abc",
          action: "ignore",
          ignoreReason: "event_not_mapped",
        },
        inFlightExecutionIds: ["exec_wait_1"],
        waitStates: [createWaitState("1", "exec_wait_1", [])],
        ...callbacks,
      });

      assert.deepStrictEqual(result, {
        status: "resumed",
        resumedCount: 1,
        runMode: "live",
      });
    })
  );

  // Which waits an event wakes is resume matching's own knowledge; the
  // orchestrator delegates and trusts the returned count, so a zero means
  // the ignore outcome stands.
  it.effect("reports ignored when resume matching wakes nothing", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 0 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.confirmed",
          correlationKey: "abc",
          action: "ignore",
          ignoreReason: "event_not_mapped",
        },
        inFlightExecutionIds: ["exec_wait_1"],
        waitStates: [
          createWaitState("1", "exec_wait_1", ["appointment.rescheduled"]),
        ],
        ...callbacks,
      });

      assert.strictEqual(callbacks.calls.resumed, 1);
      assert.deepStrictEqual(result, {
        status: "ignored",
        runMode: "live",
        reason: "event_not_mapped",
      });
    })
  );

  // An entrypoint that supplies no resume callback cannot resume, so a wait
  // listening for this very event still does not consume it.
  it.effect("skips resumes entirely when no resume callback is supplied", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 1 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.confirmed",
          correlationKey: "abc",
          action: "start",
        },
        inFlightExecutionIds: ["exec_wait_1"],
        waitStates: [
          createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
        ],
        startExecution: callbacks.startExecution,
        cancelInFlightRuns: callbacks.cancelInFlightRuns,
      });

      assert.strictEqual(callbacks.calls.resumed, 0);
      assert.strictEqual(callbacks.calls.started, 1);
      assert.deepStrictEqual(result, {
        status: "running",
        executionId: "exec_started",
        runId: "run_started",
        runMode: "live",
      });
    })
  );

  // The waiting run consumes the event: resumes run before start, so a Start
  // mapping that a waiting run is listening for wakes that run instead of
  // opening a second one for the same entity.
  it.effect(
    "lets a waiting run consume a Start event instead of starting a new run",
    () =>
      Effect.gen(function* () {
        const callbacks = makeCallbacks({ resumedCount: 1 });

        const result = yield* orchestrateTriggerExecution({
          runMode: "live",
          routing: {
            eventType: "appointment.confirmed",
            correlationKey: "abc",
            action: "start",
          },
          inFlightExecutionIds: ["exec_wait_1"],
          waitStates: [
            createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
          ],
          ...callbacks,
        });

        assert.strictEqual(callbacks.calls.resumed, 1);
        assert.strictEqual(callbacks.calls.started, 0);
        assert.deepStrictEqual(result, {
          status: "resumed",
          resumedCount: 1,
          runMode: "live",
        });
      })
  );

  it.effect("starts a run when a Start event matches no waiting run", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks();

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.created",
          correlationKey: "abc",
          action: "start",
        },
        inFlightExecutionIds: ["exec_wait_1"],
        waitStates: [
          createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
        ],
        ...callbacks,
      });

      assert.strictEqual(callbacks.calls.started, 1);
      assert.deepStrictEqual(result, {
        status: "running",
        executionId: "exec_started",
        runId: "run_started",
        runMode: "live",
      });
    })
  );

  it.effect("starts a run when every matching wait state resume fails", () =>
    Effect.gen(function* () {
      const callbacks = makeCallbacks({ resumedCount: 0 });

      const result = yield* orchestrateTriggerExecution({
        runMode: "live",
        routing: {
          eventType: "appointment.confirmed",
          correlationKey: "abc",
          action: "start",
        },
        inFlightExecutionIds: ["exec_wait_1"],
        waitStates: [
          createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
        ],
        ...callbacks,
      });

      assert.strictEqual(callbacks.calls.resumed, 1);
      assert.strictEqual(callbacks.calls.started, 1);
      assert.deepStrictEqual(result, {
        status: "running",
        executionId: "exec_started",
        runId: "run_started",
        runMode: "live",
      });
    })
  );
});
