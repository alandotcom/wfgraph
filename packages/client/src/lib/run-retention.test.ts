import { describe, expect, it } from "vitest";
import {
  retentionWindowLabel,
  runRetentionNotice,
} from "#src/lib/run-retention";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("retentionWindowLabel", () => {
  it("names whole days from one day up, and whole hours below", () => {
    expect(retentionWindowLabel(30 * DAY_MS)).toBe("30 days");
    expect(retentionWindowLabel(DAY_MS)).toBe("1 day");
    expect(retentionWindowLabel(23 * HOUR_MS)).toBe("23 hours");
    expect(retentionWindowLabel(HOUR_MS)).toBe("1 hour");
  });

  it("rounds a window that is not a whole count of the unit", () => {
    expect(retentionWindowLabel(7 * DAY_MS + MINUTE_MS)).toBe("7 days");
    expect(retentionWindowLabel(DAY_MS + 13 * HOUR_MS)).toBe("2 days");
    expect(retentionWindowLabel(DAY_MS + 11 * HOUR_MS)).toBe("1 day");
    expect(retentionWindowLabel(36 * HOUR_MS)).toBe("2 days");
    expect(retentionWindowLabel(2 * HOUR_MS + 29 * MINUTE_MS)).toBe("2 hours");
    expect(retentionWindowLabel(2 * HOUR_MS + 30 * MINUTE_MS)).toBe("3 hours");
  });

  it("never says zero", () => {
    expect(retentionWindowLabel(MINUTE_MS)).toBe("1 hour");
    expect(retentionWindowLabel(1_000)).toBe("1 hour");
    expect(retentionWindowLabel(0)).toBe("1 hour");
  });
});

describe("runRetentionNotice", () => {
  it("states the window, and says nothing for a host that keeps every run", () => {
    expect(runRetentionNotice(30 * DAY_MS)).toBe(
      "Runs are deleted 30 days after they finish."
    );
    expect(runRetentionNotice(null)).toBeNull();
  });
});
