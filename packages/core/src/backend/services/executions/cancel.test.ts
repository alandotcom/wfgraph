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
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import { postExecutionCancel } from "#src/backend/services/executions/cancel";

type Repo = ExecutionRepo["Service"];

const findWorkflowIdById = vi.fn<Repo["findWorkflowIdById"]>(() =>
  Effect.succeed("wf_1")
);
const findStatusById = vi.fn<Repo["findStatusById"]>(() =>
  Effect.succeed({ id: "exec_1", status: "running" })
);
const listWaitingStates = vi.fn<Repo["listWaitingStates"]>(() =>
  Effect.succeed([])
);
const recordAuditEvent = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const endInFlight = vi.fn<Repo["endInFlight"]>(() =>
  Effect.succeed({
    executionId: "exec_1",
    status: "canceled",
    claim: null,
    didWrite: true,
  })
);

/** A run parked on a wait, as `listWaitingStates` hands one over. */
function createWaitState(
  overrides: Partial<WorkflowWaitState> = {}
): WorkflowWaitState {
  return {
    id: "wait_1",
    executionId: "exec_1",
    workflowId: "wf_1",
    nodeId: "node_wait",
    nodeName: "Wait for confirmation",
    waitType: "event",
    status: "waiting",
    resumeToken: "token_1",
    waitUntil: null,
    subscribedEvents: ["app/appointment.confirmed"],
    metadata: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    resumedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** Every read answers `exec_1` mid-run and no wait row, unless a case says otherwise. */
beforeEach(() => {
  findWorkflowIdById.mockImplementation(() => Effect.succeed("wf_1"));
  findStatusById.mockImplementation(() =>
    Effect.succeed({ id: "exec_1", status: "running" })
  );
  listWaitingStates.mockImplementation(() => Effect.succeed([]));
  recordAuditEvent.mockImplementation(() => Effect.void);
  endInFlight.mockImplementation(() =>
    Effect.succeed({
      executionId: "exec_1",
      status: "canceled",
      claim: null,
      didWrite: true,
    })
  );
});

const services = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExecutionRepo({
    findWorkflowIdById,
    findStatusById,
    listWaitingStates,
    recordAuditEvent,
    endInFlight,
  })
);

describe("postExecutionCancel", () => {
  // The Runs view's Cancel button used to refuse anything but a run parked on a Wait,
  // even though a Lifecycle Rules Cancel Event reaches every in-flight status
  // (ADR-0007's routed continuation). This is the status that button was
  // missing: a run standing on an ordinary node, with no wait row at all.
  it.effect("cancels a running execution standing on no wait", () =>
    Effect.gen(function* () {
      const result = yield* postExecutionCancel("exec_1").pipe(
        Effect.provide(services)
      );

      assert.deepStrictEqual(result, {
        success: true,
        status: "canceled",
        cancelledWaitStates: 0,
      });
      assert.strictEqual(endInFlight.mock.calls.length, 1);
      assert.strictEqual(
        recordAuditEvent.mock.calls.filter(
          ([event]) => event.eventType === "run_cancel_requested"
        ).length,
        1
      );
    })
  );

  it.effect("still cancels a run parked on a Wait", () =>
    Effect.gen(function* () {
      findStatusById.mockImplementation(() =>
        Effect.succeed({ id: "exec_1", status: "waiting" })
      );
      listWaitingStates.mockImplementation(() =>
        Effect.succeed([createWaitState()])
      );

      const result = yield* postExecutionCancel("exec_1").pipe(
        Effect.provide(services)
      );

      assert.deepStrictEqual(result, {
        success: true,
        status: "canceled",
        cancelledWaitStates: 1,
      });
      assert.strictEqual(endInFlight.mock.calls.length, 1);
    })
  );

  // The terminal write cancels the run's wait rows and deletes its schedule
  // row in one transaction, so a refused write leaves nothing half-done and a
  // canceled run has nothing left to stop.
  it.effect(
    "answers an internal failure when the terminal write is refused",
    () =>
      Effect.gen(function* () {
        endInFlight.mockImplementationOnce(() =>
          Effect.fail(new DatabaseError({ cause: "connection lost" }))
        );

        const failure = yield* postExecutionCancel("exec_1").pipe(
          Effect.provide(services),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "InternalFailure");
        assert.strictEqual(
          recordAuditEvent.mock.calls.filter(
            ([event]) => event.eventType === "run_cancelled"
          ).length,
          0
        );
      })
  );

  it.effect("refuses a run that is already canceled", () =>
    Effect.gen(function* () {
      findStatusById.mockImplementation(() =>
        Effect.succeed({ id: "exec_1", status: "canceled" })
      );

      const failure = yield* postExecutionCancel("exec_1").pipe(
        Effect.provide(services),
        Effect.flip
      );

      assert.strictEqual(failure._tag, "Conflict");
      assert.strictEqual(endInFlight.mock.calls.length, 0);
    })
  );

  it.effect("refuses a run that already reached a terminal status", () =>
    Effect.gen(function* () {
      findStatusById.mockImplementation(() =>
        Effect.succeed({ id: "exec_1", status: "completed" })
      );

      const failure = yield* postExecutionCancel("exec_1").pipe(
        Effect.provide(services),
        Effect.flip
      );

      assert.strictEqual(failure._tag, "Conflict");
      assert.strictEqual(endInFlight.mock.calls.length, 0);
    })
  );

  // A Cancel Event claims a run without ending it, and the run then walks its
  // Canceled outlet, which may park on a Wait of its own for a week. The Runs
  // panel button reaches that run while it is still in flight, and ending it
  // here would take the outlet away from it.
  it.effect("refuses a run an earlier Cancel claim already owns", () =>
    Effect.gen(function* () {
      endInFlight.mockImplementation(() =>
        Effect.succeed({
          executionId: "exec_1",
          status: "running",
          claim: {
            kind: "cancel",
            requestedAt: new Date("2026-10-19T15:00:00.000Z"),
            eventName: "app/appointment.canceled",
            payload: { reason: "customer left" },
          },
          didWrite: false,
        })
      );

      const failure = yield* postExecutionCancel("exec_1").pipe(
        Effect.provide(services),
        Effect.flip
      );

      assert.strictEqual(failure._tag, "Conflict");
      assert.strictEqual(failure.error, "Execution is already canceling");
      // The run is already on its way out under the earlier claim, so this call
      // leaves no request on its timeline.
      assert.deepStrictEqual(
        recordAuditEvent.mock.calls.filter(
          ([event]) => event.eventType === "run_cancel_requested"
        ),
        []
      );
    })
  );

  it.effect("answers not-found when the execution does not exist", () =>
    Effect.gen(function* () {
      findWorkflowIdById.mockImplementation(() => Effect.succeed(null));

      const failure = yield* postExecutionCancel("exec_gone").pipe(
        Effect.provide(services),
        Effect.flip
      );

      assert.strictEqual(failure._tag, "NotFound");
    })
  );
});
