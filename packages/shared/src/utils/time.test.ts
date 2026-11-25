import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatClockTimeWithSeconds,
  formatDayAndTime,
  getCompactRelativeTime,
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

describe("formatDayAndTime", () => {
  it("names the day, the month and the time", () => {
    expect(formatDayAndTime(new Date(2026, 7, 12, 14, 32))).toBe(
      "12 Aug, 14:32"
    );
  });

  it("pads the day, so the string holds one width all month", () => {
    // It sits in a fixed-height strip beside a monospaced run id; an unpadded
    // day would move everything after it by a character on nine days in ten.
    const first = formatDayAndTime(new Date(2026, 0, 1, 23, 59));
    const later = formatDayAndTime(new Date(2026, 0, 31, 23, 59));

    expect(first).toBe("01 Jan, 23:59");
    expect(later.length).toBe(first.length);
  });
});
