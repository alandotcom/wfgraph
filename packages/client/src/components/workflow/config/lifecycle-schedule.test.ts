import { describe, expect, it } from "vitest";
import {
  formatFireTime,
  matchesTimeZone,
  parseTimeInput,
  presetOf,
  rowOfSchedule,
  type ScheduleRow,
  scheduleReadout,
  scheduleRefusalOf,
  timeInputValue,
  timeZoneChoices,
  withPreset,
  withPresetFields,
} from "./lifecycle-schedule";

function row(cron: string, timeZone = "America/New_York"): ScheduleRow {
  return rowOfSchedule({ cron, timeZone });
}

describe("presetOf", () => {
  it.each([
    ["0 * * * *", "hourly"],
    ["15 * * * *", "hourly"],
    ["0 9 * * *", "daily"],
    ["30 17 * * 1-5", "weekdays"],
    ["0 9 * * 5", "weekly"],
    ["0 9 * * 7", "weekly"],
    ["*/15 * * * *", "custom"],
    ["0 9 1 * *", "custom"],
    ["0 9 * 1 *", "custom"],
    ["0 9,17 * * *", "custom"],
    ["0 9 * * 1,3", "custom"],
    ["not a cron", "custom"],
  ])("reads %s as %s", (cron, preset) => {
    expect(presetOf(cron)).toBe(preset);
  });
});

describe("withPreset", () => {
  it("carries the row's time onto the preset it switches to", () => {
    const weekly = withPreset(row("30 17 * * 1-5"), "weekly");
    expect(weekly).toMatchObject({ preset: "weekly", cron: "30 17 * * 1" });
    expect(withPreset(weekly, "daily").cron).toBe("30 17 * * *");
  });

  it("starts a preset at 9:00 AM when the row names no fixed time", () => {
    expect(withPreset(row("*/15 * * * *"), "weekdays").cron).toBe(
      "0 9 * * 1-5"
    );
  });

  it("keeps the expression when the builder switches to Custom", () => {
    expect(withPreset(row("0 9 * * 1-5"), "custom")).toMatchObject({
      preset: "custom",
      cron: "0 9 * * 1-5",
    });
  });
});

describe("withPresetFields", () => {
  it("rewrites the time and the weekday of a weekly schedule", () => {
    const weekly = row("0 9 * * 1");
    expect(
      withPresetFields(weekly, { time: { hour: 14, minute: 5 } }).cron
    ).toBe("5 14 * * 1");
    expect(withPresetFields(weekly, { weekday: "0" }).cron).toBe("0 9 * * 0");
  });

  it("leaves a Custom row's expression alone", () => {
    const custom = withPreset(row("0 9 * * *"), "custom");
    expect(withPresetFields(custom, { weekday: "3" })).toBe(custom);
  });
});

describe("time input", () => {
  it("round-trips a clock time", () => {
    expect(timeInputValue("5 9 * * *")).toBe("09:05");
    expect(parseTimeInput("09:05")).toEqual({ hour: 9, minute: 5 });
  });

  it("reads a blank or varying time as none", () => {
    expect(timeInputValue("*/5 * * * *")).toBe("");
    expect(parseTimeInput("")).toBeUndefined();
  });
});

describe("scheduleRefusalOf", () => {
  it("accepts schedules a save accepts", () => {
    expect(
      scheduleRefusalOf([row("0 9 * * 1-5"), row("0 9 * * 1-5", "UTC")])
    ).toBeUndefined();
  });

  it("names the row and field of an invalid expression", () => {
    expect(
      scheduleRefusalOf([
        row("0 9 * * *"),
        { ...row("0 9 * * *"), cron: "9am" },
      ])
    ).toEqual({
      message: expect.stringContaining("five fields"),
      rowIndex: 1,
      field: "cron",
    });
  });

  it("names the row and field of an unknown time zone", () => {
    expect(scheduleRefusalOf([row("0 9 * * *", "Mars/Olympus")])).toEqual({
      message: expect.stringContaining("IANA time zone"),
      rowIndex: 0,
      field: "timeZone",
    });
  });

  it("names no row for a duplicate", () => {
    expect(
      scheduleRefusalOf([row("0 9 * * *"), { ...row("0 9 * * *"), id: "b" }])
    ).toEqual({
      message:
        "Two schedules have the same cron expression and time zone. Remove one of them.",
      rowIndex: undefined,
      field: undefined,
    });
  });
});

describe("readout", () => {
  it("formats a fire time in the schedule's own zone", () => {
    expect(
      formatFireTime(new Date("2026-11-09T14:00:00Z"), "America/New_York")
    ).toBe("Mon Nov 9, 9:00 AM");
  });

  it("describes a schedule with its next fire times", () => {
    // Friday Nov 6, 2026 at 7:00 AM in New York.
    expect(
      scheduleReadout(
        { cron: "0 9 * * 1-5", timeZone: "America/New_York" },
        new Date("2026-11-06T12:00:00Z"),
        3
      )
    ).toEqual({
      description: "Every weekday at 9:00 AM (America/New_York)",
      nextFires: [
        "Fri Nov 6, 9:00 AM",
        "Mon Nov 9, 9:00 AM",
        "Tue Nov 10, 9:00 AM",
      ],
    });
  });
});

describe("time zones", () => {
  it("lists UTC and keeps a stored zone the browser spells differently", () => {
    const choices = timeZoneChoices(["Asia/Calcutta"]);
    expect(choices).toContain("UTC");
    expect(choices).toContain("Asia/Calcutta");
    expect(choices).toContain("America/New_York");
  });

  it("finds a zone by its city written with a space", () => {
    expect(matchesTimeZone("America/New_York", "new york")).toBe(true);
    expect(matchesTimeZone("Europe/London", "new york")).toBe(false);
  });
});
