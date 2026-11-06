import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatClockTimeWithSeconds,
  formatDayAndTime,
} from "#src/utils/time";

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
