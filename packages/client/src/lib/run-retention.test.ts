import { describe, expect, it } from "vitest";
import {
  retentionWindowLabel,
  runRetentionNotice,
} from "#src/lib/run-retention";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("retentionWindowLabel", () => {
  it("names whole days, then whole hours, then minutes", () => {
    expect(retentionWindowLabel(30 * DAY_MS)).toBe("30 days");
    expect(retentionWindowLabel(DAY_MS)).toBe("1 day");
    expect(retentionWindowLabel(36 * HOUR_MS)).toBe("36 hours");
    expect(retentionWindowLabel(HOUR_MS)).toBe("1 hour");
    expect(retentionWindowLabel(90 * MINUTE_MS)).toBe("90 minutes");
    expect(retentionWindowLabel(MINUTE_MS)).toBe("1 minute");
  });

  // A window under a minute still reads as a length a person can act on.
  it("rounds to the nearest minute and never says fewer than one", () => {
    expect(retentionWindowLabel(DAY_MS + 30_000)).toBe("1441 minutes");
    expect(retentionWindowLabel(1_000)).toBe("1 minute");
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
