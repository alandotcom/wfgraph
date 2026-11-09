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
import { cancelInFlightRuns } from "#src/backend/services/executions/end-runs";

type Repo = ExecutionRepo["Service"];

const cancelRun = vi.fn<Repo["cancelRun"]>(() =>
  Effect.succeed({ kind: "ended", status: "canceled" } as const)
);
const recordAuditEvent = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);

/** Every write lands, unless a case says otherwise. */
beforeEach(() => {
  cancelRun.mockImplementation(() =>
    Effect.succeed({ kind: "ended", status: "canceled" } as const)
  );
  recordAuditEvent.mockImplementation(() => Effect.void);
});

const services = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExecutionRepo({ cancelRun, recordAuditEvent })
);

const refusedWrite = () =>
  Effect.fail(new DatabaseError({ cause: "connection lost" }));

describe("cancelInFlightRuns", () => {
  it.effect("reports a run whose terminal write the database refused", () =>
    Effect.gen(function* () {
      cancelRun
        .mockImplementationOnce(() =>
          Effect.succeed({ kind: "ended", status: "canceled" } as const)
        )
        .mockImplementationOnce(refusedWrite);

      const summary = yield* cancelInFlightRuns({
        workflowId: "workflow_1",
        executionIds: ["exec_success", "exec_failed"],
        reason: "Cancelled by event",
        eventName: "appointment.cancelled",
      }).pipe(Effect.provide(services));

      // The winner's run_cancelled rode on its terminal write. The other
      // run's status could not be written, which run_cancel_requested says.
      assert.deepStrictEqual(
        recordAuditEvent.mock.calls.map(([entry]) => [
          entry.executionId,
          entry.eventType,
        ]),
        [["exec_failed", "run_cancel_requested"]]
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
        cancelRun.mockImplementationOnce(() =>
          Effect.succeed({ kind: "exit_claimed" } as const)
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

      assert.strictEqual(cancelRun.mock.calls.length, 1);
      assert.deepStrictEqual(summary.endedExecutionIds, ["exec_1"]);
    })
  );

  // The race the lock decides: the run finished between the caller's in-flight
  // query and this write, so the row keeps its terminal status. A run another
  // cancel ended first is the same race.
  it.effect(
    "does not count an execution that ended before the cancel write",
    () =>
      Effect.gen(function* () {
        cancelRun
          .mockImplementationOnce(() =>
            Effect.succeed({
              kind: "already_ended",
              status: "completed",
            } as const)
          )
          .mockImplementationOnce(() =>
            Effect.succeed({
              kind: "already_ended",
              status: "canceled",
            } as const)
          )
          .mockImplementationOnce(() =>
            Effect.succeed({ kind: "ended", status: "canceled" } as const)
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

        assert.strictEqual(recordAuditEvent.mock.calls.length, 0);
        assert.deepStrictEqual(summary, {
          endedExecutionIds: ["exec_still_waiting"],
          failedExecutionIds: [],
          claimedExecutionIds: [],
        });
      })
  );
});
