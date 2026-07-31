import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import { startWithConcurrency } from "./concurrency";

// Announcing a supersede has its own cases in `end-runs.test.ts`; here it is the
// call that matters, so the neighbour is replaced for this file.
const { announceSupersededRunsMock, announceReclaimedRunsMock } = vi.hoisted(
  () => ({
    announceSupersededRunsMock: vi.fn(),
    announceReclaimedRunsMock: vi.fn(),
  })
);

vi.mock("#src/backend/services/executions/end-runs", () => ({
  announceSupersededRuns: announceSupersededRunsMock,
  announceReclaimedRuns: announceReclaimedRunsMock,
}));

const recordAuditEventMock = vi.fn<
  ExecutionRepo["Service"]["recordAuditEvent"]
>(() => Effect.void);

const workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  graph: { nodes: [], edges: [] },
};

const eventStart = {
  source: "event" as const,
  eventName: "app/appointment.created",
  entityValue: "appt_8813",
  deliveryId: "dlv_4021",
};

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    workflowRunId: null,
    deliveryId: null,
    enqueuedAt: null,
    status: "running",
    startSource: "event",
    runMode: "live",
    startEventName: "app/appointment.created",
    entityValue: "appt_8813",
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T00:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    cancelRequestedAt: null,
    cancelEventName: null,
    cancelPayload: null,
    ...overrides,
  };
}

type StartForEntityInput = Parameters<
  ExecutionRepo["Service"]["startForEntity"]
>[0];

/** The locked transaction's answer, and what it was asked for. */
function stubStart(outcome: EntityStartOutcome) {
  const calls: StartForEntityInput[] = [];

  return {
    calls,
    layer: Layer.mergeAll(
      stubExecutionRepo({
        startForEntity: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return outcome;
          }),
        markEnqueued: () => Effect.void,
        recordAuditEvent: recordAuditEventMock,
      }),
      stubInngestClient({
        sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
      })
    ),
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
  reclaimedExecutionIds: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  recordAuditEventMock.mockImplementation(() => Effect.void);
  announceSupersededRunsMock.mockReturnValue(
    Effect.succeed({ failedExecutionIds: [] })
  );
  announceReclaimedRunsMock.mockReturnValue(
    Effect.succeed({ failedExecutionIds: [] })
  );
});

describe("startWithConcurrency", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("starts and hands the run to the bus", () =>
      Effect.gen(function* () {
        const repo = stubStart(startedOutcome);

        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "unlimited",
          start: eventStart,
          runMode: "live",
          payload: { appointment: { id: "appt_8813" } },
          logger: makeRecordingLogger().logger,
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(outcome, {
          status: "started",
          executionId: "exec_new",
          runId: "evt_1",
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.strictEqual(repo.calls[0]?.concurrency, "unlimited");
        assert.strictEqual(repo.calls[0]?.execution.entityValue, "appt_8813");
      })
    );

    // The refusal is the locked transaction's, made while it held the candidates;
    // what happens here is that it becomes visible.
    it.effect("records a first-wins refusal and what it deferred to", () =>
      Effect.gen(function* () {
        const repo = stubStart({
          status: "refused",
          inFlightExecutionIds: ["exec_running"],
        });
        const recorder = makeRecordingLogger();

        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "first-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: recorder.logger,
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(outcome, {
          status: "not_started",
          reason: "concurrency_first_wins",
          inFlightExecutionIds: ["exec_running"],
        });

        const audit = recordAuditEventMock.mock.calls[0]?.[0];
        assert.strictEqual(audit?.eventType, "run_refused");
        assert.strictEqual(audit?.metadata?.reason, "concurrency_first_wins");
        // One arrival can reach many workflows, so the row says which arrival it
        // was: an operator reading a refusal finds the delivery behind it.
        assert.strictEqual(audit?.metadata?.deliveryId, "dlv_4021");
        assert.include(audit?.message, "Concurrency is first-wins");
        assert.deepStrictEqual(recorder.infoLines, [
          {
            message: "Start refused",
            properties: {
              reason: "concurrency_first_wins",
              entityValue: "appt_8813",
              inFlightExecutionIds: ["exec_running"],
            },
          },
        ]);
      })
    );

    // Nothing to be one-at-a-time about is not a reason to start anyway: the
    // workflow asked for one run per entity, and a payload with no entity cannot
    // be held to that.
    it.effect("refuses a start with no Entity Value where it compares", () =>
      Effect.gen(function* () {
        // The repository is left refusing: opening a run would be the bug.
        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "newest-wins",
          start: { source: "event", eventName: "ops/nightly.swept" },
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({ recordAuditEvent: recordAuditEventMock }),
              stubInngestClient()
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          status: "not_started",
          reason: "entity_value_missing",
          inFlightExecutionIds: [],
        });
        assert.strictEqual(
          recordAuditEventMock.mock.calls[0]?.[0]?.metadata?.reason,
          "entity_value_missing"
        );
      })
    );

    // An unlimited workflow compares nothing, so the same start goes through.
    it.effect("starts without an Entity Value when nothing compares", () =>
      Effect.gen(function* () {
        const repo = stubStart(startedOutcome);

        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "unlimited",
          start: { source: "event", eventName: "ops/nightly.swept" },
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(Effect.provide(repo.layer));

        assert.strictEqual(outcome.status, "started");
        assert.strictEqual(repo.calls[0]?.execution.entityValue, undefined);
      })
    );

    // Supersede-then-start: the rows the transaction flipped are told to stop
    // before the new run is announced, and their ids come back so the caller
    // knows not to deliver this Event to their waits.
    it.effect("announces the runs the transaction superseded", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        announceSupersededRunsMock.mockImplementation(() =>
          Effect.sync(() => {
            order.push("announce");
            return { failedExecutionIds: [] };
          })
        );

        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "newest-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubExecutionRepo({
                startForEntity: () =>
                  Effect.sync(() => {
                    order.push("open");
                    return {
                      status: "started" as const,
                      execution: createExecution(),
                      supersededExecutionIds: ["exec_old"],
                      reclaimedExecutionIds: [],
                    };
                  }),
                markEnqueued: () => Effect.void,
                recordAuditEvent: recordAuditEventMock,
              }),
              stubInngestClient({
                sendRunRequested: () =>
                  Effect.sync(() => {
                    order.push("enqueue");
                    return { eventId: "evt_1" };
                  }),
              })
            )
          )
        );

        assert.deepStrictEqual(order, ["open", "announce", "enqueue"]);
        assert.deepStrictEqual(outcome, {
          status: "started",
          executionId: "exec_new",
          runId: "evt_1",
          supersededExecutionIds: ["exec_old"],
          failedToSupersede: [],
        });

        const announced = announceSupersededRunsMock.mock.calls[0]?.[0];
        assert.deepStrictEqual(announced.executionIds, ["exec_old"]);
      })
    );

    // The arrival is what makes opening a row idempotent, so a retried lifecycle
    // step re-claims the row it already opened instead of starting a second run.
    it.effect("names the arrival on the row it opens", () =>
      Effect.gen(function* () {
        const repo = stubStart(startedOutcome);

        yield* startWithConcurrency({
          workflow,
          concurrency: "first-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(Effect.provide(repo.layer));

        assert.strictEqual(repo.calls[0]?.execution.deliveryId, "dlv_4021");
      })
    );

    // Those rows now say `failed` and only the signal can make that true of the
    // runs: the stamp they are missing can go missing on a run Inngest took.
    it.effect("signals the runs it reclaimed from before the bus", () =>
      Effect.gen(function* () {
        const recorder = makeRecordingLogger();

        yield* startWithConcurrency({
          workflow,
          concurrency: "first-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: recorder.logger,
        }).pipe(
          Effect.provide(
            stubStart({
              status: "started",
              execution: createExecution(),
              supersededExecutionIds: [],
              reclaimedExecutionIds: ["exec_stuck"],
            }).layer
          )
        );

        const announced = announceReclaimedRunsMock.mock.calls[0]?.[0];
        assert.deepStrictEqual(announced.executionIds, ["exec_stuck"]);
        assert.deepStrictEqual(recorder.infoLines, [
          {
            message: "Closed runs that never reached the bus",
            properties: { executionIds: ["exec_stuck"] },
          },
        ]);
      })
    );

    // A signal that did not land leaves a live run against a superseded row, so
    // the caller hears about it rather than reading one clean new run.
    it.effect("carries a half-failed supersede back to the caller", () =>
      Effect.gen(function* () {
        announceSupersededRunsMock.mockReturnValue(
          Effect.succeed({ failedExecutionIds: ["exec_old"] })
        );

        const outcome = yield* startWithConcurrency({
          workflow,
          concurrency: "newest-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(
          Effect.provide(
            stubStart({
              status: "started",
              execution: createExecution(),
              supersededExecutionIds: ["exec_old"],
              reclaimedExecutionIds: [],
            }).layer
          )
        );

        assert.deepStrictEqual(
          outcome.status === "started" ? outcome.failedToSupersede : [],
          ["exec_old"]
        );
      })
    );
  });
});
