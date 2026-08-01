/**
 * The run-log rows around a node's work, and the one thing that happens when
 * writing them fails.
 *
 * The close is swallowed on purpose - see `runWithStepLog` - so the log line is
 * the only record that a row was left open, and what it names is the whole of
 * what an operator has to work with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
