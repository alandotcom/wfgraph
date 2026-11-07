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
import { DatabaseError } from "#src/backend/lib/effect/database";
import type { ExecutionDriver } from "#src/backend/services/executions/driver";
import type { WorkflowVersion } from "#src/backend/lib/db/schema";
import type {
  EntityStartOutcome,
  ExecutionRepo,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";

type Repo = ExecutionRepo["Service"];
type Driver = ExecutionDriver["Service"];

const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const findVersionByIdMock = vi.fn<WorkflowRepo["Service"]["findVersionById"]>();

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
 * A `workflow_versions` row as `findVersionById` answers with it. A start reads
 * the row the new Execution's `workflowVersionId` names, and the opening
 * timeline entry takes the version number from there.
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
    lastPinnedAt: null,
  };
}

function createExecution(
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return {
    id: "exec_new",
    workflowId: "wf_1",
    deliveryId: null,
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
    scheduledFor: null,
    scheduleCron: null,
    scheduleTimeZone: null,
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

type StartRunInput = Parameters<Driver["startRun"]>[0];

/** The locked transaction's answer, and what it was asked for. */
function stubStart(outcome: EntityStartOutcome) {
  const calls: StartRunInput[] = [];

  return {
    calls,
    layer: Layer.mergeAll(
      stubExecutionRepo({ recordAuditEvent: recordAuditEventMock }),
      stubExecutionDriver({
        startRun: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return outcome;
          }),
      }),
      stubWorkflowRepo({ findVersionById: findVersionByIdMock })
    ),
  };
}

const startedOutcome: EntityStartOutcome = {
  status: "started",
  execution: createExecution(),
  supersededExecutionIds: [],
};

beforeEach(() => {
  recordAuditEventMock.mockReset();
  findVersionByIdMock.mockReset();

  recordAuditEventMock.mockImplementation(() => Effect.void);
  findVersionByIdMock.mockImplementation(() =>
    Effect.succeed(versionRow({ id: "ver_1", version: 3 }))
  );
});

describe("startWithConcurrency", () => {
  layer(SilentAppLoggerLayer)((it) => {
    // The executor's start opens the row, schedules it and writes its opening
    // entry in one transaction, so the entry is handed over with the row.
    it.effect("starts the run on the executor with its opening entry", () =>
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
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.strictEqual(repo.calls.length, 1);
        assert.strictEqual(repo.calls[0]?.concurrency, "unlimited");
        assert.strictEqual(repo.calls[0]?.execution.entityValue, "appt_8813");
        assert.strictEqual(repo.calls[0]?.execution.workflowVersionId, "ver_1");
        assert.strictEqual(
          repo.calls[0]?.startedEntry.message,
          "Event-triggered run of v3 started for app/appointment.created, to real recipients"
        );
        assert.deepStrictEqual(repo.calls[0]?.startedEntry.metadata, {
          startSource: "event",
          runMode: "live",
          versionKind: "published",
          versionNumber: 3,
          eventName: "app/appointment.created",
          entityValue: "appt_8813",
          deliveryId: "dlv_4021",
        });
        assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
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

    // Supersede-then-start: the transaction that opened and scheduled the new
    // run flipped the displaced rows, which are then stopped, and their ids come
    // back so the caller knows not to deliver this Event to their waits.
    // Announcing is `end-runs`' own; here it is the stop that proves the real
    // neighbour ran.
    it.effect("announces the runs the transaction superseded", () =>
      Effect.gen(function* () {
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
            }).layer
          )
        );

        assert.deepStrictEqual(outcome, {
          status: "started",
          executionId: "exec_new",
          supersededExecutionIds: ["exec_old"],
          failedToSupersede: [],
        });
        assert.deepInclude(recordAuditEventMock.mock.calls[0]?.[0], {
          executionId: "exec_old",
          eventType: "run_superseded",
          message: "Superseded by a newer start from app/appointment.created",
        });
      })
    );

    // The opening entry names the graph the new row pins, read by the id the
    // row will carry, so no start path can label a run with another version.
    it.effect("names the version the new row pins in its opening entry", () =>
      Effect.gen(function* () {
        findVersionByIdMock.mockImplementation(() =>
          Effect.succeed(versionRow({ id: "ver_2", version: 2 }))
        );
        const repo = stubStart(startedOutcome);

        yield* startWithConcurrency({
          workflow: { ...workflow, versionId: "ver_2" },
          concurrency: "first-wins",
          start: eventStart,
          runMode: "live",
          payload: {},
          logger: makeRecordingLogger().logger,
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(findVersionByIdMock.mock.calls, [["ver_2"]]);
        assert.include(
          repo.calls[0]?.startedEntry.message ?? "",
          "run of v2 started"
        );
        assert.deepInclude(repo.calls[0]?.startedEntry.metadata, {
          versionNumber: 2,
        });
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

    // A timeline entry the database refused leaves a superseded run with no
    // record of why it ended, so the caller hears about it rather than
    // reading one clean new run.
    it.effect("carries a half-recorded supersede back to the caller", () =>
      Effect.gen(function* () {
        recordAuditEventMock.mockReturnValue(
          Effect.fail(new DatabaseError({ cause: "connection lost" }))
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
            }).layer
          )
        );

        assert.deepStrictEqual(
          outcome.status === "started" ? outcome.failedToSupersede : [],
          ["exec_old"]
        );
        assert.strictEqual(
          recordAuditEventMock.mock.calls[0]?.[0].executionId,
          "exec_old"
        );
      })
    );
  });
});
