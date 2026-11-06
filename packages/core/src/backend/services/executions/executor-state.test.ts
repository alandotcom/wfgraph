import { describe, expect, it } from "vitest";
import { overdueAfterMs } from "#src/backend/services/executions/executor-state";

describe("overdueAfterMs", () => {
  // A worker loop at its default poll looks many times a minute; a host that
  // polls less often, or the Worker's minute-apart Cron Trigger, gets two of
  // its own intervals before a due run reads as unclaimed.
  it("waits two polls or two Cron Trigger ticks, and never under a minute", () => {
    expect(overdueAfterMs(1_000)).toBe(60_000);
    expect(overdueAfterMs(45_000)).toBe(90_000);
    expect(overdueAfterMs(undefined)).toBe(120_000);
  });
});
