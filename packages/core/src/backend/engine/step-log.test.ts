/**
 * The run-log rows around a node's work, and the one thing that happens when
 * writing them fails.
 *
 * The close is swallowed on purpose - see `runWithStepLog` - so the log line is
 * the only record that a row was left open, and what it names is the whole of
 * what an operator has to work with.
 */

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Layer, Logger, References } from "effect";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { runWithStepLog } from "#src/backend/engine/step-log";
import {
  noopWorkflowStore,
  type WorkflowStore,
} from "#src/backend/engine/store";
import { DatabaseError } from "#src/backend/lib/effect/database";

const context = {
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Send SMS",
  nodeType: "twilio/send-sms",
  runMode: "live" as const,
};

function storeRefusingTheClose(): WorkflowStore {
  return {
    ...noopWorkflowStore,
    startStepLog: () => Effect.succeed({ logId: "log_1", startTime: 0 }),
    completeStepLog: () =>
      Effect.fail(
        new DatabaseError({ cause: new Error("run log unreachable") })
      ),
  };
}

function recordingLogger() {
  const lines: {
    message: unknown;
    properties: Record<string, unknown>;
  }[] = [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    lines.push({
      message: Array.isArray(message) ? message[0] : message,
      properties: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  return {
    lines,
    layer: Layer.merge(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, "All")
    ),
  };
}

/** What the two writes are wrapped in. This file is about the writes, not replay. */
const runtime = createInMemoryWorkflowRuntime();

describe("runWithStepLog", () => {
  // The row is now stuck at `running`, and the usual cause is the database
  // itself: a row id alone can only be resolved against the table that just
  // refused a write, and an outage produces a burst of them.
  it.effect("names the run and the node when the closing write fails", () =>
    Effect.gen(function* () {
      const captured = recordingLogger();
      const result = yield* runWithStepLog(
        { store: storeRefusingTheClose(), context, runtime, input: {} },
        () => Effect.succeed({ success: true, data: { sid: "SM1" } } as const)
      ).pipe(Effect.provide(captured.layer));

      expect(result.success).toBe(true);
      expect(captured.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Could not close a run-log row",
            properties: expect.objectContaining({
              logId: "log_1",
              executionId: "exec_1",
              nodeId: "node_1",
              nodeName: "Send SMS",
              status: "success",
            }),
          }),
        ])
      );
    })
  );
});

/**
 * A row's duration is the work one attempt did.
 *
 * The open is memoized, so the handle a replay reads back carries the clock of
 * whichever attempt inserted the row. A duration taken from it would count the
 * wait the run sat through as well, and an early node's row would grow toward
 * the whole run's elapsed time.
 */
describe("the duration a closed row carries", () => {
  const answer = () =>
    Effect.succeed({ success: true, data: { sid: "SM1" } } as const);

  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect(
    "leaves the row alone when the body replays inside one attempt",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        const store = createRecordingWorkflowStore();
        const memo = new Map<string, unknown>();
        const target = {
          store,
          context,
          runtime: createInMemoryWorkflowRuntime({ memo }),
          input: {},
        };

        yield* runWithStepLog(target, () => {
          vi.advanceTimersByTime(200);
          return answer();
        });

        // The run parks on a Wait downstream, and an hour later the whole body is
        // replayed: same memo, so the open is a hit and the row is the same one.
        // The work comes back out of the memo, so a second close would record the
        // near-zero elapsed of a replay over the 200 the attempt really took.
        vi.advanceTimersByTime(3_600_000);

        yield* runWithStepLog(target, answer);

        const closes = store.callsOf("completeStepLog");
        expect(closes.map((close) => close.logId)).toEqual(["log_1"]);
        expect(closes.map((close) => close.durationMs)).toEqual([200]);
      })
  );

  it.effect(
    "times each attempt's own work rather than everything since the row opened",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        const store = createRecordingWorkflowStore();
        const memo = new Map<string, unknown>();
        const target = (attempt: number) => ({
          store,
          context,
          runtime: createInMemoryWorkflowRuntime({ memo, attempt }),
          input: {},
        });

        yield* runWithStepLog(target(0), () => {
          vi.advanceTimersByTime(200);
          return answer();
        });

        // A retry an hour on, which reaches the same row and is entitled to correct
        // what the first attempt wrote.
        vi.advanceTimersByTime(3_600_000);

        yield* runWithStepLog(target(1), () => {
          vi.advanceTimersByTime(5);
          return answer();
        });

        const closes = store.callsOf("completeStepLog");
        expect(closes.map((close) => close.logId)).toEqual(["log_1", "log_1"]);
        expect(closes.map((close) => close.durationMs)).toEqual([200, 5]);
      })
  );
});
