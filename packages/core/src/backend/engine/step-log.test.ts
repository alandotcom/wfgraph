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
import {
  createInMemoryWorkflowRuntime,
  type WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import { runWithStepLog } from "#src/backend/engine/step-log";
import { engineFailure } from "#src/backend/engine/engine-failure";
import {
  noopWorkflowStore,
  type WorkflowStore,
} from "#src/backend/engine/store";
import { DatabaseError, LeaseLost } from "#src/backend/lib/effect/database";

const context = {
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Send SMS",
  nodeType: "twilio/send-sms",
  runMode: "live" as const,
};

function storeRefusingTheClose(
  refusal: DatabaseError | LeaseLost = new DatabaseError({
    cause: new Error("run log unreachable"),
  })
): WorkflowStore {
  return {
    ...noopWorkflowStore,
    startStepLog: () => Effect.succeed({ logId: "log_1", startTime: 0 }),
    completeStepLog: () => Effect.fail(refusal),
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

const closeWarning = "Could not close a run-log row";

/** The failure a node's step answers when the vendor it calls throws. */
const vendorThrew = engineFailure("failure", "The vendor is down");

describe("runWithStepLog", () => {
  // A row the database refused to close is stuck at `running`: a row id alone
  // can only be resolved against the table that just refused a write, and an
  // outage produces a burst of them.
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
            message: closeWarning,
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

  // A step that throws stops the pass, and the store then refuses the error
  // close of every node the pass was running with `LeaseLost`. That refusal is
  // part of every retriable step failure, so it writes no log line.
  it.effect(
    "logs nothing when the close is refused because the pass stopped",
    () =>
      Effect.gen(function* () {
        const captured = recordingLogger();
        const store = storeRefusingTheClose(
          new LeaseLost({
            message: "This pass has stopped and writes nothing more",
          })
        );
        yield* Effect.flip(
          runWithStepLog({ store, context, runtime, input: {} }, () =>
            Effect.fail(vendorThrew)
          ).pipe(Effect.provide(captured.layer))
        );

        expect(
          captured.lines.filter((line) => line.message === closeWarning)
        ).toEqual([]);
      })
  );

  it.effect(
    "logs once when the database refuses the close of a failed step",
    () =>
      Effect.gen(function* () {
        const captured = recordingLogger();
        yield* Effect.flip(
          runWithStepLog(
            { store: storeRefusingTheClose(), context, runtime, input: {} },
            () => Effect.fail(vendorThrew)
          ).pipe(Effect.provide(captured.layer))
        );

        expect(
          captured.lines.filter((line) => line.message === closeWarning)
        ).toEqual([
          expect.objectContaining({
            properties: expect.objectContaining({
              logId: "log_1",
              nodeId: "node_1",
              status: "error",
            }),
          }),
        ]);
      })
  );
});

/**
 * A runtime like a pass that stopped after the node's log open: the open
 * runs, and every later step is refused before its function is called.
 */
function runtimeStoppedAfterOpen(): WorkflowExecutionRuntime {
  const inner = createInMemoryWorkflowRuntime();
  let calls = 0;
  const refuseAfterOpen = <T>(fn: () => Promise<T>): Promise<T> => {
    calls += 1;
    return calls === 1
      ? fn()
      : Promise.reject(new Error("This pass has stopped"));
  };
  return {
    ...inner,
    run: (_step, fn) => refuseAfterOpen(fn),
    runIdempotent: (_step, fn) => refuseAfterOpen(fn),
  };
}

// The close is the store's own quiet write, so neither a refused close nor a
// refused step after the open can stand in for what the work answered.
describe("a close that cannot be written", () => {
  it.effect("keeps the work's own failure", () =>
    Effect.gen(function* () {
      const vendorDown = new Error("The vendor is down");
      const error = yield* Effect.flip(
        runWithStepLog(
          {
            store: storeRefusingTheClose(),
            context,
            runtime: runtimeStoppedAfterOpen(),
            input: {},
          },
          () => Effect.fail(vendorDown)
        )
      );

      expect(error).toBe(vendorDown);
    })
  );

  it.effect("answers the work's success", () =>
    Effect.gen(function* () {
      const result = yield* runWithStepLog(
        {
          store: storeRefusingTheClose(),
          context,
          runtime: runtimeStoppedAfterOpen(),
          input: {},
        },
        () => Effect.succeed({ success: true, data: { sid: "SM1" } } as const)
      );

      expect(result).toEqual({ success: true, data: { sid: "SM1" } });
    })
  );
});

/**
 * A row's duration is the work one attempt did, timed around that work.
 *
 * The open and the close run on every pass. A replay reads its work back out
 * of the memo, so the close a replay makes carries the replay's own near-zero
 * duration, and the pass's store (`createDbWorkflowStore`) skips that close
 * for a row an earlier attempt already closed.
 */
describe("the duration a closed row carries", () => {
  const answer = () =>
    Effect.succeed({ success: true, data: { sid: "SM1" } } as const);

  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect(
    "times a replay's close from the replay's own work, on the same row",
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

        // The run parks on a Wait downstream, and an hour later the whole body
        // is replayed against the same memo. The open reaches the same row, and
        // the work comes back out of the memo in no time at all.
        vi.advanceTimersByTime(3_600_000);

        yield* runWithStepLog(target, answer);

        const closes = store.callsOf("completeStepLog");
        expect(closes.map((close) => close.logId)).toEqual(["log_1", "log_1"]);
        expect(closes.map((close) => close.durationMs)).toEqual([200, 0]);
      })
  );

  it.effect(
    "times each attempt's own work rather than everything since the row opened",
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
          return Effect.succeed({
            success: false,
            error: { message: "The vendor refused the message" },
          } as const);
        });

        // A later attempt an hour on, which reaches the same row and is
        // entitled to correct the error the first attempt wrote.
        vi.advanceTimersByTime(3_600_000);

        yield* runWithStepLog(target, () => {
          vi.advanceTimersByTime(5);
          return answer();
        });

        const closes = store.callsOf("completeStepLog");
        expect(closes.map((close) => close.logId)).toEqual(["log_1", "log_1"]);
        expect(closes.map((close) => close.status)).toEqual([
          "error",
          "success",
        ]);
        expect(closes.map((close) => close.durationMs)).toEqual([200, 5]);
      })
  );
});
