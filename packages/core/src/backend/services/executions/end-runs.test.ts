import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import {
  announceSupersededRuns,
  cancelInFlightRuns,
} from "#src/backend/services/executions/end-runs";

type Repo = ExecutionRepo["Service"];

const endInFlight = vi.fn<Repo["endInFlight"]>(() =>
  Effect.succeed({
    executionId: "exec_1",
    status: "canceled",
    claim: null,
    didWrite: true,
  })
);
const recordAuditEvent = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);

/** Every write lands, unless a case says otherwise. */
beforeEach(() => {
  endInFlight.mockImplementation(() =>
    Effect.succeed({
      executionId: "exec_1",
      status: "canceled",
      claim: null,
      didWrite: true,
    })
  );
  recordAuditEvent.mockImplementation(() => Effect.void);
});

const services = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExecutionRepo({ endInFlight, recordAuditEvent })
);

const refusedWrite = () =>
  Effect.fail(new DatabaseError({ cause: "connection lost" }));

describe("cancelInFlightRuns", () => {
  it.effect("reports a run whose terminal write the database refused", () =>
    Effect.gen(function* () {
      endInFlight
        .mockImplementationOnce(() =>
          Effect.succeed({
            executionId: "exec_success",
            status: "canceled",
            claim: null,
            didWrite: true,
          })
        )
        .mockImplementationOnce(refusedWrite);

      const summary = yield* cancelInFlightRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_success", "exec_failed"],
        reason: "Cancelled by event",
        eventName: "appointment.cancelled",
      }).pipe(Effect.provide(services));

      assert.deepStrictEqual(endInFlight.mock.calls, [
        [
          {
            executionId: "exec_success",
            status: "canceled",
            error: "Cancelled by event",
          },
        ],
        [
          {
            executionId: "exec_failed",
            status: "canceled",
            error: "Cancelled by event",
          },
        ],
      ]);
      // One run_cancelled for the winner, one run_cancel_requested recording
      // that the other run's status could not be written.
      assert.deepStrictEqual(
        recordAuditEvent.mock.calls.map(([entry]) => [
          entry.executionId,
          entry.eventType,
        ]),
        [
          ["exec_success", "run_cancelled"],
          ["exec_failed", "run_cancel_requested"],
        ]
      );
      assert.deepStrictEqual(summary, {
        endedExecutionIds: ["exec_success"],
        failedExecutionIds: ["exec_failed"],
        claimedExecutionIds: [],
      });
    })
  );

  it.effect(
    "leaves an in-flight termination claim to the run that owns it",
    () =>
      Effect.gen(function* () {
        endInFlight.mockImplementationOnce(() =>
          Effect.succeed({
            executionId: "exec_claimed",
            status: "running",
            claim: {
              kind: "exit",
              requestedAt: new Date("2026-10-19T15:00:00.000Z"),
              reason: "entity_condition_not_met",
              nodeId: "send-reminder",
            },
            didWrite: false,
          })
        );

        const summary = yield* cancelInFlightRuns({
          workflowId: "workflow_1",
          executionIds: ["exec_claimed"],
          reason: "Cancelled manually",
        }).pipe(Effect.provide(services));

        assert.strictEqual(recordAuditEvent.mock.calls.length, 0);
        // The claim is not a failure: the run that owns it is still walking, and
        // the caller answers a conflict rather than an internal failure.
        assert.deepStrictEqual(summary, {
          endedExecutionIds: [],
          failedExecutionIds: [],
          claimedExecutionIds: ["exec_claimed"],
        });
      })
  );

  it.effect("ends each execution once when it is named twice", () =>
    Effect.gen(function* () {
      const summary = yield* cancelInFlightRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_1", "exec_1"],
        reason: "Cancelled by event",
      }).pipe(Effect.provide(services));

      assert.strictEqual(endInFlight.mock.calls.length, 1);
      assert.deepStrictEqual(summary.endedExecutionIds, ["exec_1"]);
    })
  );

  // The compare-and-set race: the run finished between the caller's in-flight
  // query and this write, so the row keeps its terminal status. A run another
  // cancel ended first is the same race.
  it.effect(
    "does not count or audit an execution that ended before the cancel write",
    () =>
      Effect.gen(function* () {
        endInFlight
          .mockImplementationOnce(() =>
            Effect.succeed({
              executionId: "exec_completed",
              status: "completed",
              claim: null,
              didWrite: false,
            })
          )
          .mockImplementationOnce(() =>
            Effect.succeed({
              executionId: "exec_already_canceled",
              status: "canceled",
              claim: null,
              didWrite: false,
            })
          )
          .mockImplementationOnce(() =>
            Effect.succeed({
              executionId: "exec_still_waiting",
              status: "canceled",
              claim: null,
              didWrite: true,
            })
          );

        const summary = yield* cancelInFlightRuns({
          workflowId: "workflow_1",
          executionIds: [
            "exec_completed",
            "exec_already_canceled",
            "exec_still_waiting",
          ],
          reason: "Cancelled by event",
          eventName: "appointment.cancelled",
        }).pipe(Effect.provide(services));

        assert.strictEqual(endInFlight.mock.calls.length, 3);
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
        assert.deepStrictEqual(summary, {
          endedExecutionIds: ["exec_still_waiting"],
          failedExecutionIds: [],
          claimedExecutionIds: [],
        });
      })
  );
});

// The rows are already terminal when this runs -- the entity lock flipped them
// and deleted their schedule rows -- so there is no compare-and-set here and no
// lost race to report. What is left is the timeline.
describe("announceSupersededRuns", () => {
  it.effect("says on each displaced run's timeline why it ended", () =>
    Effect.gen(function* () {
      const summary = yield* announceSupersededRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_old"],
        reason: "Superseded by a newer start from appointment.rescheduled",
        eventName: "appointment.rescheduled",
      }).pipe(Effect.provide(services));

      assert.strictEqual(endInFlight.mock.calls.length, 0);
      assert.strictEqual(
        recordAuditEvent.mock.calls.at(0)?.[0]?.eventType,
        "run_superseded"
      );
      assert.deepStrictEqual(summary, { failedExecutionIds: [] });
    })
  );

  it.effect("names the runs whose timeline entry was refused", () =>
    Effect.gen(function* () {
      recordAuditEvent.mockImplementationOnce(refusedWrite);

      const summary = yield* announceSupersededRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_old"],
        reason: "Superseded by a newer start",
      }).pipe(Effect.provide(services));

      assert.deepStrictEqual(summary, { failedExecutionIds: ["exec_old"] });
    })
  );
});
