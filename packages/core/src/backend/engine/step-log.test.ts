/**
 * The run-log rows around a node's work, and the one thing that happens when
 * writing them fails.
 *
 * The close is swallowed on purpose - see `runWithStepLog` - so the log line is
 * the only record that a row was left open, and what it names is the whole of
 * what an operator has to work with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { WorkflowStore } from "#src/backend/engine/store";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("#src/backend/lib/logger", () => ({
  getAppLogger: () => ({
    warn: loggerWarnMock,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const context = {
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Send SMS",
  nodeType: "twilio/send-sms",
  runMode: "live" as const,
};

function storeRefusingTheClose(): WorkflowStore {
  return {
    startStepLog: () => Promise.resolve({ logId: "log_1", startTime: 0 }),
    completeStepLog: () => Promise.reject(new Error("run log unreachable")),
  } as unknown as WorkflowStore;
}

beforeEach(() => {
  loggerWarnMock.mockClear();
});

/** What the two writes are wrapped in. This file is about the writes, not replay. */
const runtime = createInMemoryWorkflowRuntime();

describe("runWithStepLog", () => {
  // The row is now stuck at `running`, and the usual cause is the database
  // itself: a row id alone can only be resolved against the table that just
  // refused a write, and an outage produces a burst of them.
  it("names the run and the node when the closing write fails", async () => {
    const result = await runWithStepLog(
      { store: storeRefusingTheClose(), context, runtime, input: {} },
      () => Promise.resolve({ success: true, data: { sid: "SM1" } } as const)
    );

    expect(result.success).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Could not close a run-log row",
      expect.objectContaining({
        logId: "log_1",
        executionId: "exec_1",
        nodeId: "node_1",
        nodeName: "Send SMS",
        status: "success",
      })
    );
  });
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
    Promise.resolve({ success: true, data: { sid: "SM1" } } as const);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times each attempt's own work rather than everything since the row opened", async () => {
    vi.useFakeTimers();
    const store = createRecordingWorkflowStore();
    const target = {
      store,
      context,
      runtime: createInMemoryWorkflowRuntime({ memo: new Map() }),
      input: {},
    };

    await runWithStepLog(target, () => {
      vi.advanceTimersByTime(200);
      return answer();
    });

    // The run parks on a Wait downstream, and an hour later the whole body is
    // replayed: same memo, so the open is a hit and the row is the same one.
    vi.advanceTimersByTime(3_600_000);

    await runWithStepLog(target, () => {
      vi.advanceTimersByTime(5);
      return answer();
    });

    const closes = store.callsOf("completeStepLog");
    expect(closes.map((close) => close.logId)).toEqual(["log_1", "log_1"]);
    expect(closes.map((close) => close.durationMs)).toEqual([200, 5]);
  });
});
