import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  executorActivityOf,
} from "#src/backend/services/executions/repo/executor-state";

const NOW = new Date("2026-03-01T09:00:00.000Z");

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function row(fields: Partial<ActivityRow>): ActivityRow {
  return {
    executionId: "exec_1",
    state: "queued",
    wakeAt: after(30_000),
    attempt: 0,
    leaseExpiresAt: null,
    runningNodeId: null,
    runningNodeName: null,
    failing: null,
    ...fields,
  };
}

describe("executorActivityOf", () => {
  it("answers a lease that ended at or before now as expired, and a lease still held as nothing", () => {
    expect(
      executorActivityOf(
        [
          row({
            state: "leased",
            leaseExpiresAt: NOW,
            runningNodeId: "send",
            runningNodeName: "Send reminder",
          }),
        ],
        NOW
      )
    ).toEqual({
      kind: "lease_expired",
      nodeId: "send",
      nodeName: "Send reminder",
      since: NOW,
    });
    expect(
      executorActivityOf(
        [row({ state: "leased", leaseExpiresAt: after(1) })],
        NOW
      )
    ).toBeNull();
  });

  it("answers a due row that is queued or asleep on its parks as unclaimed", () => {
    expect(executorActivityOf([row({ wakeAt: NOW })], NOW)).toEqual({
      kind: "unclaimed",
      dueSince: NOW,
    });
    expect(
      executorActivityOf([row({ state: "waiting", wakeAt: after(-5) })], NOW)
    ).toEqual({ kind: "unclaimed", dueSince: after(-5) });
    expect(executorActivityOf([row({ state: "waiting" })], NOW)).toBeNull();
  });

  it("names the step with the most failures, then the run body's own, and nothing for a queued row with no failure", () => {
    expect(
      executorActivityOf(
        [
          row({ failing: { nodeId: "notify", nodeName: null, failures: 1 } }),
          row({
            failing: { nodeId: "send", nodeName: "Send reminder", failures: 3 },
          }),
        ],
        NOW
      )
    ).toEqual({
      kind: "retrying",
      nodeId: "send",
      nodeName: "Send reminder",
      nextTryAt: after(30_000),
      failures: 3,
    });
    expect(executorActivityOf([row({ attempt: 2 })], NOW)).toEqual({
      kind: "retrying",
      nodeId: null,
      nodeName: null,
      nextTryAt: after(30_000),
      failures: 2,
    });
    expect(executorActivityOf([row({})], NOW)).toBeNull();
    expect(executorActivityOf([], NOW)).toBeNull();
  });
});
