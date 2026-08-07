import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { InngestError } from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
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
const endInFlight = vi.fn<Repo["endInFlight"]>(() => Effect.succeed(true));
const cancelWaits = vi.fn<Repo["cancelWaits"]>(() => Effect.succeed([]));
const sendCancelRequested = vi.fn(
  () => Effect.void as Effect.Effect<void, InngestError>
);

/** A run parked on a wait, as `listWaitingStates` hands one over. */
function createWaitState(
  overrides: Partial<WorkflowWaitState> = {}
): WorkflowWaitState {
  return {
    id: "wait_1",
    executionId: "exec_1",
    workflowId: "wf_1",
    runId: "run_1",
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
  vi.clearAllMocks();
  findWorkflowIdById.mockImplementation(() => Effect.succeed("wf_1"));
  findStatusById.mockImplementation(() =>
    Effect.succeed({ id: "exec_1", status: "running" })
  );
  listWaitingStates.mockImplementation(() => Effect.succeed([]));
  recordAuditEvent.mockImplementation(() => Effect.void);
  endInFlight.mockImplementation(() => Effect.succeed(true));
  cancelWaits.mockImplementation(() => Effect.succeed([]));
  sendCancelRequested.mockImplementation(() => Effect.void);
});

const services = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExecutionRepo({
    findWorkflowIdById,
    findStatusById,
    listWaitingStates,
    recordAuditEvent,
    endInFlight,
    cancelWaits,
  }),
  stubInngestClient({ sendCancelRequested })
);

describe("postExecutionCancel", () => {
  // The Runs panel button used to refuse anything but a run parked on a Wait,
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
      assert.deepStrictEqual(cancelWaits.mock.calls, [[["wait_1"]]]);
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
