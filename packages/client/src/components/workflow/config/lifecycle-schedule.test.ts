import { describe, expect, it } from "vitest";
import {
  formatFireTime,
  matchesTimeZone,
  parseTimeInput,
  presetOf,
  rowOfSchedule,
  type ScheduleRow,
  readScheduleRows,
  scheduleReadout,
  timeInputValue,
  timeZoneChoices,
  unsavedScheduleMessage,
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

describe("readScheduleRows", () => {
  const NOTHING_SAVED = new Map();

  it("saves every row the stored rules can hold", () => {
    const reading = readScheduleRows(
      [row("0 9 * * 1-5"), row("0 9 * * 1-5", "UTC")],
      NOTHING_SAVED
    );
    expect(reading.schedules).toEqual([
      { cron: "0 9 * * 1-5", timeZone: "America/New_York" },
      { cron: "0 9 * * 1-5", timeZone: "UTC" },
    ]);
    expect(reading.unsaved).toEqual([]);
  });

  it("saves the valid rows and names the row and field of an invalid expression", () => {
    const reading = readScheduleRows(
      [row("0 9 * * *"), { ...row("0 10 * * *"), cron: "9am" }],
      NOTHING_SAVED
    );
    expect(reading.schedules).toEqual([
      { cron: "0 9 * * *", timeZone: "America/New_York" },
    ]);
    expect(reading.unsaved).toEqual([
      {
        message: expect.stringContaining("five fields"),
        index: 1,
        field: "cron",
      },
    ]);
  });

  it("names the row and field of an unknown time zone", () => {
    expect(
      readScheduleRows([row("0 9 * * *", "Mars/Olympus")], NOTHING_SAVED)
        .unsaved
    ).toEqual([
      {
        message: expect.stringContaining("IANA time zone"),
        index: 0,
        field: "timeZone",
      },
    ]);
  });

  it("saves the first of two duplicates and names the second", () => {
    const reading = readScheduleRows(
      [row("0 9 * * *"), { ...row("0 9 * * *"), id: "b" }],
      NOTHING_SAVED
    );
    expect(reading.schedules).toHaveLength(1);
    expect(reading.unsaved).toEqual([
      {
        message:
          "Two schedules have the same cron expression and time zone. Remove one of them.",
        index: 1,
        field: undefined,
      },
    ]);
  });

  it("keeps the schedule an unsaved row last saved", () => {
    const saved = row("0 9 * * *");
    const editing = { ...saved, preset: "custom" as const, cron: "0 9 * *" };
    const reading = readScheduleRows(
      [editing],
      new Map([[saved.id, { cron: saved.cron, timeZone: saved.timeZone }]])
    );
    expect(reading.schedules).toEqual([
      { cron: "0 9 * * *", timeZone: "America/New_York" },
    ]);
    expect(reading.savedByRow.get(saved.id)).toEqual({
      cron: "0 9 * * *",
      timeZone: "America/New_York",
    });
    expect(reading.unsaved).toHaveLength(1);
  });
});

describe("unsavedScheduleMessage", () => {
  it("names the row as its card is titled", () => {
    expect(
      unsavedScheduleMessage({
        message: "A schedule needs an IANA time zone.",
        index: 1,
        field: "timeZone",
      })
    ).toBe("Schedule 2 isn't saved. A schedule needs an IANA time zone.");
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
