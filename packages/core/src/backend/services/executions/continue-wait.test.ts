import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionSummary,
  NewAuditEvent,
  ParkResolution,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import { continueWaitNow } from "#src/backend/services/executions/continue-wait";

/** A draft run parked on a Wait, unless a case says otherwise. */
function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    id: "exec_1",
    workflowId: "wf_1",
    workflowVersionId: "snap_1",
    versionKind: "draft_snapshot",
    versionNumber: null,
    status: "waiting",
    startSource: "manual",
    runMode: "test",
    startEventName: null,
    entityValue: null,
    entityType: null,
    entityId: null,
    input: null,
    output: null,
    error: null,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    scheduledFor: null,
    scheduleCron: null,
    scheduleTimeZone: null,
    completedAt: null,
    duration: null,
    ...overrides,
  };
}

/** A one-day delay park, as `listWaitingStates` hands one over. */
function delayPark(
  overrides: Partial<WorkflowWaitState> = {}
): WorkflowWaitState {
  return {
    id: "wait_1",
    executionId: "exec_1",
    workflowId: "wf_1",
    nodeId: "node_wait",
    nodeName: "Wait a day",
    waitType: "delay",
    status: "waiting",
    resumeToken: null,
    waitUntil: new Date("2026-03-02T10:00:00.000Z"),
    subscribedEvents: [],
    metadata: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    resumedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/**
 * Runs Continue now against one run and its parks, answering the outcome with
 * every park the driver was asked to end and every timeline entry written.
 */
function continueAgainst(input: {
  execution: ExecutionSummary | null;
  waits?: WorkflowWaitState[] | undefined;
  resolution?: ParkResolution | undefined;
}) {
  const ended: { executionId: string; waitStateId: string }[] = [];
  const entries: NewAuditEvent[] = [];
  const services = Layer.mergeAll(
    SilentAppLoggerLayer,
    stubExecutionRepo({
      findSummaryById: () => Effect.succeed(input.execution),
      listWaitingStates: () => Effect.succeed(input.waits ?? [delayPark()]),
      recordAuditEvent: (entry) =>
        Effect.sync(() => {
          entries.push(entry);
        }),
    }),
    stubExecutionDriver({
      endParkNow: (park) =>
        Effect.sync(() => {
          ended.push(park);
          return input.resolution ?? { resolved: true, requeued: true };
        }),
    })
  );
  return continueWaitNow({ executionId: "exec_1", waitStateId: "wait_1" }).pipe(
    Effect.provide(services),
    Effect.result,
    Effect.map((outcome) => ({ outcome, ended, entries }))
  );
}

/** The tag a refused call failed with, or "succeeded". */
function tagOf(outcome: Result.Result<unknown, { _tag: string }>): string {
  return Result.isFailure(outcome) ? outcome.failure._tag : "succeeded";
}

describe("continueWaitNow", () => {
  it.effect(
    "ends a draft run's waiting park through the driver and records who brought it forward",
    () =>
      Effect.gen(function* () {
        const { outcome, ended, entries } = yield* continueAgainst({
          execution: summary(),
        });

        assert.strictEqual(tagOf(outcome), "succeeded");
        assert.deepStrictEqual(ended, [
          { executionId: "exec_1", waitStateId: "wait_1" },
        ]);
        assert.deepStrictEqual(
          entries.map((entry) => entry.eventType),
          ["run_resumed"]
        );
        assert.deepStrictEqual(entries[0]?.metadata, {
          nodeId: "node_wait",
          continuedNow: true,
        });
      })
  );

  // An event Wait always parks with a timeout, and Continue now takes the path
  // that timeout takes.
  it.effect("ends an event Wait's park as its timeout", () =>
    Effect.gen(function* () {
      const { outcome, ended } = yield* continueAgainst({
        execution: summary(),
        waits: [
          delayPark({
            waitType: "event",
            resumeToken: "token_1",
            subscribedEvents: ["app/appointment.confirmed"],
          }),
        ],
      });

      assert.strictEqual(tagOf(outcome), "succeeded");
      assert.strictEqual(ended.length, 1);
    })
  );

  it.effect(
    "refuses a run of a published version and writes nothing, whatever its mode",
    () =>
      Effect.gen(function* () {
        const live = yield* continueAgainst({
          execution: summary({ versionKind: "published", versionNumber: 3 }),
        });
        const test = yield* continueAgainst({
          execution: summary({
            versionKind: "published",
            versionNumber: 3,
            runMode: "test",
          }),
        });

        assert.strictEqual(tagOf(live.outcome), "InvalidInput");
        assert.strictEqual(tagOf(test.outcome), "InvalidInput");
        assert.strictEqual(live.ended.length + test.ended.length, 0);
        assert.strictEqual(live.entries.length + test.entries.length, 0);
      })
  );

  it.effect("answers not found for a run that does not exist", () =>
    Effect.gen(function* () {
      const { outcome, ended } = yield* continueAgainst({ execution: null });

      assert.strictEqual(tagOf(outcome), "NotFound");
      assert.strictEqual(ended.length, 0);
    })
  );

  it.effect("refuses a run that has already finished", () =>
    Effect.gen(function* () {
      const { outcome, ended } = yield* continueAgainst({
        execution: summary({ status: "completed" }),
      });

      assert.strictEqual(tagOf(outcome), "Conflict");
      assert.strictEqual(ended.length, 0);
    })
  );

  it.effect("refuses a step that is not waiting", () =>
    Effect.gen(function* () {
      const { outcome, ended } = yield* continueAgainst({
        execution: summary(),
        waits: [delayPark({ id: "wait_other" })],
      });

      assert.strictEqual(tagOf(outcome), "Conflict");
      assert.strictEqual(ended.length, 0);
    })
  );

  it.effect("refuses a park with no time to bring forward", () =>
    Effect.gen(function* () {
      const { outcome, ended } = yield* continueAgainst({
        execution: summary(),
        waits: [delayPark({ waitUntil: null })],
      });

      assert.strictEqual(tagOf(outcome), "InvalidInput");
      assert.strictEqual(ended.length, 0);
    })
  );

  // An Event, a Cancel or the deadline itself can resolve the park between the
  // read and the write. The write then sets nothing, and the timeline says
  // nothing about a Continue now that did not happen.
  it.effect(
    "refuses a park another wake resolved first, recording nothing",
    () =>
      Effect.gen(function* () {
        const { outcome, ended, entries } = yield* continueAgainst({
          execution: summary(),
          resolution: { resolved: false, requeued: false },
        });

        assert.strictEqual(tagOf(outcome), "Conflict");
        assert.strictEqual(ended.length, 1);
        assert.strictEqual(entries.length, 0);
      })
  );
});
