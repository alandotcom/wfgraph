import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import {
  type EntityStartOutcome,
  type ExecutionRepo,
  UNSENT_RUN_RECLAIM_REASON,
  type WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";

type Repo = ExecutionRepo["Service"];

const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const findVersionByIdMock = vi.fn<WorkflowRepo["Service"]["findVersionById"]>();
const stopRunMock = vi.fn<ExecutionDriver["Service"]["stopRun"]>(
  () => Effect.void
);
const enqueueRunMock = vi.fn<ExecutionDriver["Service"]["enqueueRun"]>(
  () => Effect.void
);

const workflow = {
  id: "wf_1",
  name: "Appointment Reminders",
  graph: { nodes: [], edges: [] },
  versionId: "ver_1",
  catalogFingerprint: "fp",
};

const eventStart = {
  source: "event" as const,
  eventName: "app/appointment.created",
  entityValue: "appt_8813",
  deliveryId: "dlv_4021",
};

/**
 * A `workflow_versions` row as `findVersionById` answers with it. The enqueue
 * reads the row an Execution's `workflowVersionId` names, and the timeline entry
 * it writes takes the version number from there.
 */
function versionRow(input: { id: string; version: number }): WorkflowVersion {
  return {
    id: input.id,
    workflowId: "wf_1",
    version: input.version,
    kind: "published",
    graph: { nodes: [], edges: [] },
    catalogFingerprint: "fp",
    graphDigest: "digest",
    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

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
    entityType: null,
    entityId: null,
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T00:00:00.000Z"),
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    terminationKind: null,
    terminationRequestedAt: null,
    terminationReason: null,
    terminationNodeId: null,
    cancelEventName: null,
    cancelPayload: null,
    workflowVersionId: "ver_1",
    ...overrides,
  };
}

type StartForEntityInput = Parameters<Repo["startForEntity"]>[0];

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
      stubExecutionDriver({
        enqueueRun: enqueueRunMock,
        stopRun: stopRunMock,
      }),
      stubWorkflowRepo({ findVersionById: findVersionByIdMock })
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
  recordAuditEventMock.mockReset();
  findVersionByIdMock.mockReset();
  stopRunMock.mockReset();
  enqueueRunMock.mockReset();

  recordAuditEventMock.mockImplementation(() => Effect.void);
  findVersionByIdMock.mockImplementation(() =>
    Effect.succeed(versionRow({ id: "ver_1", version: 3 }))
  );
  stopRunMock.mockImplementation(() => Effect.void);
  enqueueRunMock.mockImplementation(() => Effect.void);
});

describe("startWithConcurrency", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("starts and hands the run to the executor", () =>
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
          runId: undefined,
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.strictEqual(repo.calls[0]?.concurrency, "unlimited");
        assert.strictEqual(repo.calls[0]?.execution.entityValue, "appt_8813");
        assert.strictEqual(repo.calls[0]?.execution.workflowVersionId, "ver_1");
        assert.deepStrictEqual(enqueueRunMock.mock.calls, [
          [{ executionId: "exec_new" }],
        ]);
        assert.strictEqual(stopRunMock.mock.calls.length, 0);
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
              stubExecutionDriver(),
              // The version read is left refusing as well: no row is opened
              // here, so nothing has a pinned version to be named by.
              stubWorkflowRepo()
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

    // Supersede-then-start: the rows the transaction flipped are stopped before
    // the new run is scheduled, and their ids come back so the caller knows not
    // to deliver this Event to their waits. Announcing is `end-runs`' own; here
    // it is the stop that proves the real neighbour ran.
    it.effect("announces the runs the transaction superseded", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        stopRunMock.mockImplementation(() =>
          Effect.sync(() => {
            order.push("announce");
          })
        );
        enqueueRunMock.mockImplementation(() =>
          Effect.sync(() => {
            order.push("enqueue");
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
              stubExecutionDriver({
                stopRun: stopRunMock,
                enqueueRun: enqueueRunMock,
              }),
              stubWorkflowRepo({ findVersionById: findVersionByIdMock })
            )
          )
        );

        assert.deepStrictEqual(order, ["open", "announce", "enqueue"]);
        assert.deepStrictEqual(outcome, {
          status: "started",
          executionId: "exec_new",
          runId: undefined,
          supersededExecutionIds: ["exec_old"],
          failedToSupersede: [],
        });
        assert.deepStrictEqual(stopRunMock.mock.calls[0]?.[0], {
          executionId: "exec_old",
        });
        assert.deepInclude(recordAuditEventMock.mock.calls[0]?.[0], {
          executionId: "exec_old",
          eventType: "run_superseded",
          message: "Superseded by a newer start from app/appointment.created",
        });
      })
    );

    // Two attempts of one delivery: the transaction answers this attempt with
    // the row the other attempt committed, which pins the version that attempt
    // loaded. The timeline entry has to name the graph the run is executing,
    // which is that older pinned version rather than the one this attempt holds.
    it.effect("names the version the committed row pins", () =>
      Effect.gen(function* () {
        findVersionByIdMock.mockImplementation(() =>
          Effect.succeed(versionRow({ id: "ver_1", version: 1 }))
        );
        const repo = stubStart({
          status: "started",
          execution: createExecution({ workflowVersionId: "ver_1" }),
          supersededExecutionIds: [],
          reclaimedExecutionIds: [],
        });

        yield* startWithConcurrency({
          workflow: { ...workflow, versionId: "ver_2" },
          concurrency: "first-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(findVersionByIdMock.mock.calls, [["ver_1"]]);
        const started = recordAuditEventMock.mock.calls.find(
          ([event]) => event.eventType === "run_started"
        )?.[0];
        assert.include(started?.message ?? "", "run of v1 started");
        assert.deepInclude(started?.metadata, { versionNumber: 1 });
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

    // Those rows now say `failed` and only the stop can make that true of the
    // runs: the stamp they are missing can go missing on a run the executor
    // took.
    it.effect("stops the runs it reclaimed before they were scheduled", () =>
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

        assert.deepStrictEqual(stopRunMock.mock.calls[0]?.[0], {
          executionId: "exec_stuck",
        });
        assert.deepInclude(recordAuditEventMock.mock.calls[0]?.[0], {
          executionId: "exec_stuck",
          eventType: "run_failed",
          message: UNSENT_RUN_RECLAIM_REASON,
        });
        assert.deepStrictEqual(recorder.infoLines, [
          {
            message: "Closed runs that never reached the bus",
            properties: { executionIds: ["exec_stuck"] },
          },
        ]);
      })
    );

    // A stop the database refused can leave a step already running to finish
    // against a superseded row, so the caller hears about it rather than
    // reading one clean new run.
    it.effect("carries a half-failed supersede back to the caller", () =>
      Effect.gen(function* () {
        stopRunMock.mockReturnValue(
          Effect.fail(new DriverError({ cause: "connection lost" }))
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
        assert.strictEqual(stopRunMock.mock.calls.length, 1);
        assert.strictEqual(
          stopRunMock.mock.calls[0]?.[0].executionId,
          "exec_old"
        );
      })
    );
  });
});
