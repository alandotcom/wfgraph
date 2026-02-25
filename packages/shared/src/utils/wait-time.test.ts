import { describe, expect, it } from "bun:test";
import {
  applyDailyWindow,
  applyWaitAllowedHours,
  resolveWaitUntil,
} from "./wait-time";

describe("applyDailyWindow", () => {
  // Window: 09:00 - 17:00 America/Los_Angeles
  const START = 9 * 60; // 540
  const END = 17 * 60; // 1020
  const TZ = "America/Los_Angeles";

  it("returns candidate unchanged when within window", () => {
    // 2026-03-10 12:00 PT = 2026-03-10 19:00 UTC (PDT is UTC-7)
    const candidate = new Date("2026-03-10T19:00:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    expect(result.getTime()).toBe(candidate.getTime());
  });

  it("shifts before-window time to same-day window start", () => {
    // 2026-03-10 08:00 PT = 2026-03-10 15:00 UTC (PDT is UTC-7)
    const candidate = new Date("2026-03-10T15:00:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    // Should shift to 09:00 PT same day = 16:00 UTC
    expect(result.toISOString()).toBe("2026-03-10T16:00:00.000Z");
  });

  it("shifts after-window time to next-day window start", () => {
    // 2026-03-10 19:30 PT = 2026-03-11 02:30 UTC (PDT is UTC-7)
    const candidate = new Date("2026-03-11T02:30:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    // Should shift to 09:00 PT next day (2026-03-11) = 2026-03-11 16:00 UTC
    expect(result.toISOString()).toBe("2026-03-11T16:00:00.000Z");
  });

  it("shifts exactly at window end to next-day start", () => {
    // 2026-03-10 17:00 PT = 2026-03-11 00:00 UTC (PDT is UTC-7)
    const candidate = new Date("2026-03-11T00:00:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    // Should shift to 09:00 PT next day = 2026-03-11 16:00 UTC
    expect(result.toISOString()).toBe("2026-03-11T16:00:00.000Z");
  });

  it("handles DST spring-forward transition", () => {
    // 2026 spring forward in America/Los_Angeles is March 8
    // 2026-03-08 02:00 AM -> clocks spring forward to 3:00 AM
    // Before DST (PST = UTC-8): 08:00 PST = 16:00 UTC on March 7
    // We want a time at 2:30 AM on March 8 which doesn't exist (spring forward)
    // Let's test March 8 at 01:00 PST (still standard) = 09:00 UTC
    const candidate = new Date("2026-03-08T09:00:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    // 01:00 PST on March 8 is before window -> shift to 09:00 PDT = 16:00 UTC
    expect(result.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("handles DST fall-back transition", () => {
    // 2026 fall back in America/Los_Angeles is November 1
    // After DST (back to PST = UTC-8): 08:00 PST on Nov 1 = 16:00 UTC
    const candidate = new Date("2026-11-01T16:00:00Z");
    const result = applyDailyWindow(candidate, START, END, TZ);
    // 08:00 PST is before 09:00 window start -> shift to 09:00 PST = 17:00 UTC
    expect(result.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
});

describe("applyWaitAllowedHours", () => {
  it("passes through when mode is off", () => {
    const candidate = new Date("2026-03-10T05:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
      waitAllowedHoursMode: "off",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
      timeZone: "America/Los_Angeles",
    });
    expect(result.date.getTime()).toBe(candidate.getTime());
    expect(result.error).toBeUndefined();
  });

  it("passes through when mode is undefined", () => {
    const candidate = new Date("2026-03-10T05:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
    });
    expect(result.date.getTime()).toBe(candidate.getTime());
    expect(result.error).toBeUndefined();
  });

  it("returns error for invalid start time", () => {
    const candidate = new Date("2026-03-10T05:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "invalid",
      waitAllowedEndTime: "17:00",
      timeZone: "America/Los_Angeles",
    });
    expect(result.error).toBeDefined();
  });

  it("returns error for inverted window (start >= end)", () => {
    const candidate = new Date("2026-03-10T05:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "17:00",
      waitAllowedEndTime: "09:00",
      timeZone: "America/Los_Angeles",
    });
    expect(result.error).toBeDefined();
  });

  it("returns error when timezone is missing", () => {
    const candidate = new Date("2026-03-10T05:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBe(
      "Timezone is required when allowed-hours window is enabled."
    );
  });

  it("applies window when daily_window mode is active", () => {
    // 2026-03-10 02:00 UTC = March 9, 19:00 PT (PDT UTC-7) -> after window
    const candidate = new Date("2026-03-10T02:00:00Z");
    const result = applyWaitAllowedHours({
      candidate,
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
      timeZone: "America/Los_Angeles",
    });
    expect(result.error).toBeUndefined();
    // 19:00 PT is after 17:00 window end -> shift to 09:00 PT next day (March 10)
    // 09:00 PDT = 16:00 UTC
    expect(result.date.toISOString()).toBe("2026-03-10T16:00:00.000Z");
  });
});

describe("resolveWaitUntil with allowed hours", () => {
  it("applies window enforcement to duration-based wait", () => {
    // now = 2026-03-10 10:00 PT = 17:00 UTC
    // duration = 4h -> candidate = 21:00 UTC = 14:00 PT (within 09:00-17:00)
    const now = new Date("2026-03-10T17:00:00Z");
    const result = resolveWaitUntil({
      now,
      waitDuration: "4h",
      waitTimezone: "America/Los_Angeles",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBeUndefined();
    // 14:00 PT is within window, so no shift
    expect(result.waitUntil?.toISOString()).toBe("2026-03-10T21:00:00.000Z");
  });

  it("shifts duration result when it lands outside window", () => {
    // now = 2026-03-10 22:00 UTC = 15:00 PT
    // duration = 4h -> candidate = 02:00 UTC next day = 19:00 PT (after 17:00 end)
    const now = new Date("2026-03-10T22:00:00Z");
    const result = resolveWaitUntil({
      now,
      waitDuration: "4h",
      waitTimezone: "America/Los_Angeles",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBeUndefined();
    // 19:00 PT -> shifts to 09:00 PT next day = 2026-03-11 16:00 UTC
    expect(result.waitUntil?.toISOString()).toBe("2026-03-11T16:00:00.000Z");
  });

  it("does not apply window when mode is off", () => {
    const now = new Date("2026-03-10T22:00:00Z");
    const result = resolveWaitUntil({
      now,
      waitDuration: "4h",
      waitTimezone: "America/Los_Angeles",
      waitAllowedHoursMode: "off",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBeUndefined();
    expect(result.waitUntil?.toISOString()).toBe("2026-03-11T02:00:00.000Z");
  });

  it("returns error for invalid window config", () => {
    const now = new Date("2026-03-10T17:00:00Z");
    const result = resolveWaitUntil({
      now,
      waitDuration: "4h",
      waitTimezone: "America/Los_Angeles",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "17:00",
      waitAllowedEndTime: "09:00",
    });
    expect(result.error).toBeDefined();
  });

  it("returns error when timezone missing with daily_window", () => {
    const now = new Date("2026-03-10T17:00:00Z");
    const result = resolveWaitUntil({
      now,
      waitDuration: "4h",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBeDefined();
  });

  it("applies window enforcement to until-based wait", () => {
    // waitUntil = 2026-03-10 02:00 AM PT = before window
    const result = resolveWaitUntil({
      waitUntil: "2026-03-10T02:00",
      waitTimezone: "America/Los_Angeles",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitAllowedEndTime: "17:00",
    });
    expect(result.error).toBeUndefined();
    // 02:00 PT is before 09:00 start -> shift to 09:00 PT same day = 16:00 UTC
    expect(result.waitUntil?.toISOString()).toBe("2026-03-10T16:00:00.000Z");
  });
});
