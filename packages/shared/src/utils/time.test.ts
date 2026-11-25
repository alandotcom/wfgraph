import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatClockTimeWithSeconds,
  getCompactRelativeTime,
  formatExactTime,
} from "#src/utils/time";

describe("getCompactRelativeTime", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it.each([
    [30_000, "now"],
    [5 * MINUTE, "5m"],
    [14 * HOUR, "14h"],
    [3 * DAY, "3d"],
    [15 * DAY, "2w"],
    [120 * DAY, "4mo"],
    [400 * DAY, "1y"],
  ])("writes an age of %i ms as %s", (ms, expected) => {
    expect(getCompactRelativeTime(ago(ms), now)).toBe(expected);
  });
});

/**
 * Local-time constructors throughout: both formatters read the viewer's own
 * clock, so building the fixtures from UTC would make the expectations depend on
 * where the suite runs.
 */
describe("formatClockTime", () => {
  it("pads both halves to two digits", () => {
    expect(formatClockTime(new Date(2026, 7, 12, 9, 4))).toBe("09:04");
  });

  it("reads the afternoon on a 24-hour clock", () => {
    expect(formatClockTime(new Date(2026, 7, 12, 14, 32))).toBe("14:32");
  });

  it("calls the first minute of the day 00:00", () => {
    expect(formatClockTime(new Date(2026, 7, 12, 0, 0))).toBe("00:00");
  });
});

describe("formatClockTimeWithSeconds", () => {
  it("adds the padded seconds to the clock reading", () => {
    expect(formatClockTimeWithSeconds(new Date(2026, 7, 12, 14, 32, 5))).toBe(
      "14:32:05"
    );
  });
});

describe("formatExactTime", () => {
  const now = new Date(2026, 10, 25, 9, 0);

  it("leaves the year out for an instant in the current year", () => {
    const text = formatExactTime(new Date(2026, 10, 23, 13, 5), now);

    expect(text).toContain("23");
    expect(text).not.toContain("2026");
  });

  it("names the year for an instant in another year", () => {
    expect(formatExactTime(new Date(2025, 10, 23, 13, 5), now)).toContain(
      "2025"
    );
  });

  it("reads to the minute, with no seconds", () => {
    const withSeconds = formatExactTime(new Date(2026, 10, 23, 13, 5, 42), now);

    expect(withSeconds).toBe(
      formatExactTime(new Date(2026, 10, 23, 13, 5, 0), now)
    );
  });
});
