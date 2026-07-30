import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import {
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";
import { announceSupersededRuns, cancelInFlightRuns } from "./end-runs";

type Repo = ExecutionRepo["Service"];

const sendCancelRequested = vi.fn(
  () => Effect.void as Effect.Effect<void, InngestError>
);
const endInFlight = vi.fn<Repo["endInFlight"]>(() => Effect.succeed(true));
const cancelWaits = vi.fn<Repo["cancelWaits"]>(() => Effect.succeed([]));
const recordAuditEvent = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);

/** Every send answers, every write lands, unless a case says otherwise. */
beforeEach(() => {
  vi.clearAllMocks();
  sendCancelRequested.mockImplementation(() => Effect.void);
  endInFlight.mockImplementation(() => Effect.succeed(true));
  cancelWaits.mockImplementation(() => Effect.succeed([]));
  recordAuditEvent.mockImplementation(() => Effect.void);
});

const services = Layer.mergeAll(
  stubExecutionRepo({ endInFlight, cancelWaits, recordAuditEvent }),
  stubInngestClient({ sendCancelRequested })
);

const refusedSend = () => Effect.fail(new InngestError({ cause: "no route" }));

describe("cancelInFlightRuns", () => {
  it.effect(
    "only marks executions and waits cancelled when the cancel signal goes out",
    () =>
      Effect.gen(function* () {
        sendCancelRequested
          .mockImplementationOnce(() => Effect.void)
          .mockImplementationOnce(refusedSend);

        const summary = yield* cancelInFlightRuns({
          workflowId: "workflow_1",
          executionIds: ["exec_success", "exec_failed"],
          waitStates: [
            { id: "wait_1", executionId: "exec_success" },
            { id: "wait_2", executionId: "exec_success" },
            { id: "wait_3", executionId: "exec_failed" },
          ],
          reason: "Cancelled by event",
          eventName: "appointment.cancelled",
        }).pipe(Effect.provide(services));

        assert.strictEqual(sendCancelRequested.mock.calls.length, 2);
        assert.deepStrictEqual(endInFlight.mock.calls, [
          [
            {
              executionId: "exec_success",
              status: "canceled",
              error: "Cancelled by event",
            },
          ],
        ]);
        assert.deepStrictEqual(cancelWaits.mock.calls, [
          [["wait_1", "wait_2"]],
        ]);
        // One run_cancelled for the winner, one run_cancel_requested recording
        // that the other run's cancel signal never went out.
        assert.strictEqual(recordAuditEvent.mock.calls.length, 2);
        assert.deepStrictEqual(summary, {
          endedExecutionIds: ["exec_success"],
          failedExecutionIds: ["exec_failed"],
        });
      })
  );

  it.effect("cancels an in-flight execution that has no wait state", () =>
    Effect.gen(function* () {
      const summary = yield* cancelInFlightRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_running"],
        waitStates: [],
        reason: "Cancelled by event appointment.rescheduled",
        eventName: "appointment.rescheduled",
      }).pipe(Effect.provide(services));

      assert.deepStrictEqual(sendCancelRequested.mock.calls, [
        [
          {
            executionId: "exec_running",
            workflowId: "workflow_1",
            reason: "Cancelled by event appointment.rescheduled",
            requestedBy: "workflow_1",
            eventType: "appointment.rescheduled",
          },
        ],
      ]);
      assert.deepStrictEqual(cancelWaits.mock.calls, [[[]]]);
      assert.deepStrictEqual(summary, {
        endedExecutionIds: ["exec_running"],
        failedExecutionIds: [],
      });
    })
  );

  it.effect(
    "sends one cancel per execution when several wait states share a run",
    () =>
      Effect.gen(function* () {
        const summary = yield* cancelInFlightRuns({
          workflowId: "workflow_1",
          executionIds: ["exec_1", "exec_1"],
          waitStates: [
            { id: "wait_1", executionId: "exec_1" },
            { id: "wait_2", executionId: "exec_1" },
          ],
          reason: "Cancelled by event",
        }).pipe(Effect.provide(services));

        assert.strictEqual(sendCancelRequested.mock.calls.length, 1);
        assert.deepStrictEqual(summary.endedExecutionIds, ["exec_1"]);
        assert.deepStrictEqual(cancelWaits.mock.calls, [
          [["wait_1", "wait_2"]],
        ]);
      })
  );

  // The compare-and-set race: the run finished between the caller's in-flight
  // query and this write, so the row keeps its terminal status.
  it.effect(
    "does not count or audit an execution that finished before the cancel write",
    () =>
      Effect.gen(function* () {
        endInFlight
          .mockImplementationOnce(() => Effect.succeed(false))
          .mockImplementationOnce(() => Effect.succeed(true));

        const summary = yield* cancelInFlightRuns({
          workflowId: "workflow_1",
          executionIds: ["exec_completed", "exec_still_waiting"],
          waitStates: [
            { id: "wait_1", executionId: "exec_completed" },
            { id: "wait_2", executionId: "exec_still_waiting" },
          ],
          reason: "Cancelled by event",
          eventName: "appointment.cancelled",
        }).pipe(Effect.provide(services));

        assert.strictEqual(endInFlight.mock.calls.length, 2);
        assert.deepStrictEqual(recordAuditEvent.mock.calls, [
          [
            {
              workflowId: "workflow_1",
              executionId: "exec_still_waiting",
              eventType: "run_cancelled",
              message: "Cancelled by event",
              metadata: { eventName: "appointment.cancelled" },
            },
          ],
        ]);
        // The lost race's wait state joins the cleanup batch: its execution is
        // terminal, and a still-waiting row on it would silently swallow future
        // events via resume matching. The CAS inside `cancelWaits` keeps this
        // safe for legitimately resumed waits.
        assert.deepStrictEqual(cancelWaits.mock.calls, [
          [["wait_1", "wait_2"]],
        ]);
        assert.deepStrictEqual(summary, {
          endedExecutionIds: ["exec_still_waiting"],
          failedExecutionIds: [],
        });
      })
  );
});

// The rows are already terminal when this runs -- the entity lock flipped them --
// so there is no compare-and-set here and no lost race to report. What is left is
// the signal and the timeline.
describe("announceSupersededRuns", () => {
  it.effect("signals each displaced run and says why on its timeline", () =>
    Effect.gen(function* () {
      const summary = yield* announceSupersededRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_old"],
        reason: "Superseded by a newer start from appointment.rescheduled",
        eventName: "appointment.rescheduled",
      }).pipe(Effect.provide(services));

      assert.strictEqual(sendCancelRequested.mock.calls.length, 1);
      assert.strictEqual(endInFlight.mock.calls.length, 0);
      assert.strictEqual(
        recordAuditEvent.mock.calls.at(0)?.[0]?.eventType,
        "run_superseded"
      );
      assert.deepStrictEqual(summary, { failedExecutionIds: [] });
    })
  );

  // A signal that does not land leaves a live run against a superseded row, and
  // the id travels back so the caller can say so.
  it.effect("names the runs no signal reached", () =>
    Effect.gen(function* () {
      sendCancelRequested.mockImplementationOnce(refusedSend);

      const summary = yield* announceSupersededRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_old"],
        reason: "Superseded by a newer start",
      }).pipe(Effect.provide(services));

      assert.deepStrictEqual(summary, { failedExecutionIds: ["exec_old"] });
    })
  );
});
