import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { rejectUnknownKeys } from "#src/types/schema";
import { formatSchemaFailure } from "#src/types/schema-message";
import {
  type CronSchedule,
  cronSchedulesSchema,
  describeCronSchedule,
  latestSlotAtOrBefore,
  nextFireAfter,
  nextFireTimes,
} from "./cron-schedule";

const NEW_YORK = "America/New_York";

function inNewYork(cron: string): CronSchedule {
  return { cron, timeZone: NEW_YORK };
}

function iso(dates: readonly (Date | undefined)[]): (string | undefined)[] {
  return dates.map((date) => date?.toISOString());
}

const decode = Schema.decodeUnknownResult(
  cronSchedulesSchema,
  rejectUnknownKeys
);

/** The message a refused list is shown, or a failure naming the acceptance. */
function refusalOf(value: unknown): string {
  const result = decode(value);
  if (result._tag === "Success") {
    throw new Error("Expected these schedules to be refused");
  }
  return formatSchemaFailure(result.failure.issue);
}

describe("cronSchedulesSchema", () => {
  it("decodes 5-field expressions in IANA zones", () => {
    expect(
      decode([
        { cron: "0 9 * * 1-5", timeZone: NEW_YORK },
        { cron: "*/15 * * * *", timeZone: "Europe/Stockholm" },
        { cron: "0 9 * * 1-5", timeZone: "UTC" },
      ])._tag
    ).toBe("Success");
  });

  it("refuses a seconds field, a nickname and uneven spacing", () => {
    for (const cron of [
      "0 0 9 * * 1-5",
      "@daily",
      "0  9 * * *",
      " 0 9 * * *",
    ]) {
      expect(refusalOf([{ cron, timeZone: NEW_YORK }])).toContain(
        "five fields separated by single spaces"
      );
    }
  });

  it("refuses a field out of range without quoting it", () => {
    const message = refusalOf([{ cron: "61 9 * * *", timeZone: NEW_YORK }]);
    expect(message).toContain("five fields");
    expect(message).not.toContain("61");
  });

  it("refuses an expression that names no date that exists", () => {
    expect(refusalOf([{ cron: "0 0 30 2 *", timeZone: NEW_YORK }])).toContain(
      "would never start a run"
    );
  });

  it("refuses a zone that is not an IANA name", () => {
    for (const timeZone of ["Mars/Olympus", "+05:00", "america/new_york", ""]) {
      expect(refusalOf([{ cron: "0 9 * * *", timeZone }])).toContain(
        "IANA time zone"
      );
    }
  });

  it("refuses a key it does not know and a missing zone", () => {
    expect(
      decode([{ cron: "0 9 * * *", timeZone: NEW_YORK, label: "x" }])._tag
    ).toBe("Failure");
    expect(refusalOf([{ cron: "0 9 * * *" }])).toContain("IANA time zone");
  });

  it("refuses the same expression and zone twice", () => {
    expect(
      refusalOf([
        { cron: "0 9 * * *", timeZone: NEW_YORK },
        { cron: "0 9 * * *", timeZone: NEW_YORK },
      ])
    ).toContain("same cron expression and time zone");
  });

  it("keeps one expression in two zones as two schedules", () => {
    expect(
      decode([
        { cron: "0 9 * * *", timeZone: NEW_YORK },
        { cron: "0 9 * * *", timeZone: "Europe/London" },
      ])._tag
    ).toBe("Success");
  });
});

describe("nextFireAfter", () => {
  it("answers the first fire strictly after the instant", () => {
    const daily = inNewYork("30 9 * * *");
    // 9:30 EDT on 2026-03-09 is itself a slot, so the next is a day later.
    expect(
      nextFireAfter(daily, new Date("2026-03-09T13:30:00Z"))?.toISOString()
    ).toBe("2026-03-10T13:30:00.000Z");
    expect(
      nextFireAfter(daily, new Date("2026-03-09T13:29:59.999Z"))?.toISOString()
    ).toBe("2026-03-09T13:30:00.000Z");
  });

  // America/New_York springs forward from 2:00 EST to 3:00 EDT on 2026-03-08
  // and falls back from 2:00 EDT to 1:00 EST on 2026-11-01. Croner's DST rules
  // are documented at https://croner.56k.guru/usage/pattern/ under "DST
  // handling", and every case below cites the half of that rule it relies on.

  it("fires a skipped fixed time once, at the first valid time after the gap", () => {
    // Fixed-time job: "A time that doesn't exist (DST spring forward) runs at
    // the first valid time after the gap, on the same day."
    const skipped = inNewYork("30 2 * * *");
    expect(
      iso(nextFireTimes(skipped, new Date("2026-03-08T05:00:00Z"), 3))
    ).toEqual([
      "2026-03-08T07:00:00.000Z", // 3:00 EDT
      "2026-03-09T06:30:00.000Z", // 2:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("runs an interval schedule on elapsed time through the gap", () => {
    // Interval job: "A time that doesn't exist is skipped." 2:00 to 2:45 do not
    // exist, so the quarter hours run straight from 1:45 EST to 3:00 EDT.
    const quarterHourly = inNewYork("*/15 * * * *");
    expect(
      iso(nextFireTimes(quarterHourly, new Date("2026-03-08T06:30:00Z"), 4))
    ).toEqual([
      "2026-03-08T06:45:00.000Z", // 1:45 EST
      "2026-03-08T07:00:00.000Z", // 3:00 EDT, fifteen minutes later
      "2026-03-08T07:15:00.000Z", // 3:15 EDT
      "2026-03-08T07:30:00.000Z",
    ]);
  });

  it("skips an hourly slot that falls inside the gap", () => {
    // Interval job, since the hour field is a wildcard: "A time that doesn't
    // exist is skipped." 2:15 does not exist, and 3:15 EDT is the next slot.
    expect(
      iso(
        nextFireTimes(
          inNewYork("15 * * * *"),
          new Date("2026-03-08T06:15:00Z"),
          2
        )
      )
    ).toEqual([
      "2026-03-08T07:15:00.000Z", // 3:15 EDT
      "2026-03-08T08:15:00.000Z", // 4:15 EDT
    ]);
  });

  it("fires a repeated fixed time once, on its first occurrence", () => {
    // Fixed-time job: "A time that occurs twice (DST fall back) runs once, at
    // the first occurrence."
    expect(
      iso(
        nextFireTimes(
          inNewYork("30 1 * * *"),
          new Date("2026-11-01T04:00:00Z"),
          2
        )
      )
    ).toEqual([
      "2026-11-01T05:30:00.000Z", // 1:30 EDT
      "2026-11-02T06:30:00.000Z", // 1:30 EST, the next day
    ]);
  });

  it("runs an interval schedule through both passes of a repeated hour", () => {
    // Interval job: "A time that occurs twice runs on both occurrences, so the
    // job keeps running through the repeated hour."
    expect(
      iso(
        nextFireTimes(
          inNewYork("*/30 * * * *"),
          new Date("2026-11-01T04:45:00Z"),
          6
        )
      )
    ).toEqual([
      "2026-11-01T05:00:00.000Z", // 1:00 EDT
      "2026-11-01T05:30:00.000Z", // 1:30 EDT
      "2026-11-01T06:00:00.000Z", // 1:00 EST
      "2026-11-01T06:30:00.000Z", // 1:30 EST
      "2026-11-01T07:00:00.000Z", // 2:00 EST
      "2026-11-01T07:30:00.000Z",
    ]);
  });

  it("answers from inside the second pass with the next real-time slot", () => {
    // "nextRun(), nextRuns(), previousRuns() and enumerate() move in real time.
    // They never return a time they have passed." From 1:10 EST the next half
    // hour is 1:30 EST.
    expect(
      nextFireAfter(
        inNewYork("*/30 * * * *"),
        new Date("2026-11-01T06:10:00Z")
      )?.toISOString()
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("reads the expression in the schedule's own zone", () => {
    expect(
      nextFireAfter(
        { cron: "0 9 * * *", timeZone: "Asia/Tokyo" },
        new Date("2026-06-01T00:00:00Z")
      )?.toISOString()
    ).toBe("2026-06-02T00:00:00.000Z");
  });
});

describe("nextFireTimes", () => {
  it("enumerates weekday mornings", () => {
    // 2026-11-06 is a Friday.
    expect(
      iso(
        nextFireTimes(
          inNewYork("0 9 * * 1-5"),
          new Date("2026-11-06T15:00:00Z"),
          3
        )
      )
    ).toEqual([
      "2026-11-09T14:00:00.000Z",
      "2026-11-10T14:00:00.000Z",
      "2026-11-11T14:00:00.000Z",
    ]);
  });

  it("answers none for a count of zero", () => {
    expect(nextFireTimes(inNewYork("* * * * *"), new Date(), 0)).toEqual([]);
  });
});

describe("latestSlotAtOrBefore", () => {
  const daily = inNewYork("0 9 * * *");

  it("answers the slot itself when the instant falls on one", () => {
    expect(
      latestSlotAtOrBefore(
        daily,
        new Date("2026-11-06T14:00:00Z")
      )?.toISOString()
    ).toBe("2026-11-06T14:00:00.000Z");
  });

  it("answers the most recent slot for a late claim, however many it missed", () => {
    // A worker down from Monday night to Thursday noon fires Thursday 9:00 once.
    expect(
      latestSlotAtOrBefore(
        daily,
        new Date("2026-11-12T17:00:00Z")
      )?.toISOString()
    ).toBe("2026-11-12T14:00:00.000Z");
  });

  it("answers the end of the gap for a skipped fixed time", () => {
    // Fixed-time job: a skipped time "runs at the first valid time after the
    // gap" (https://croner.56k.guru/usage/pattern/), and previousRuns() walks
    // the same runs backward.
    expect(
      latestSlotAtOrBefore(
        inNewYork("30 2 * * *"),
        new Date("2026-03-08T07:20:00Z")
      )?.toISOString()
    ).toBe("2026-03-08T07:00:00.000Z");
  });

  it("answers a fixed time's first occurrence from inside the second pass", () => {
    // Fixed-time job: a repeated time "runs once, at the first occurrence", and
    // previousRuns() moves in real time (https://croner.56k.guru/usage/pattern/).
    // At 1:20 EST, 1:45 EDT is the run forty-five minutes back.
    expect(
      latestSlotAtOrBefore(
        inNewYork("45 1 * * *"),
        new Date("2026-11-01T06:20:00Z")
      )?.toISOString()
    ).toBe("2026-11-01T05:45:00.000Z");
  });

  it("answers an interval's second-pass slot inside the repeated hour", () => {
    // Interval job: a repeated time "runs on both occurrences"
    // (https://croner.56k.guru/usage/pattern/). At 1:10 EST the last half hour
    // is 1:00 EST.
    expect(
      latestSlotAtOrBefore(
        inNewYork("*/30 * * * *"),
        new Date("2026-11-01T06:10:00Z")
      )?.toISOString()
    ).toBe("2026-11-01T06:00:00.000Z");
  });

  it.each([
    ["*/15 * * * *", "2026-11-01T04:00:00Z"],
    ["*/15 * * * *", "2026-03-08T05:00:00Z"],
    ["30 1 * * *", "2026-10-30T04:00:00Z"],
    ["30 2 * * *", "2026-03-06T04:00:00Z"],
  ])("agrees with nextFireAfter on every slot of %s from %s", (cron, from) => {
    // Both directions "move in real time"
    // (https://croner.56k.guru/usage/pattern/), so walking back from a run
    // and forward from the run before it land on the same instants.
    const schedule = inNewYork(cron);
    for (const fire of nextFireTimes(schedule, new Date(from), 16)) {
      expect(latestSlotAtOrBefore(schedule, fire)?.toISOString()).toBe(
        fire.toISOString()
      );
      const previous = latestSlotAtOrBefore(
        schedule,
        new Date(fire.getTime() - 1)
      );
      expect(previous && nextFireAfter(schedule, previous)?.toISOString()).toBe(
        fire.toISOString()
      );
    }
  });
});

describe("describeCronSchedule", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["5 * * * *", "Every hour at :05"],
    ["0 9 * * *", "Every day at 9:00 AM"],
    ["0 9 * * 1-5", "Every weekday at 9:00 AM"],
    ["30 14 * * 1", "Every Monday at 2:30 PM"],
    ["0 0 * * 7", "Every Sunday at 12:00 AM"],
    ["0 12 1 * *", "On day 1 of every month at 12:00 PM"],
    ["0 9 1,15 * *", "0 9 1,15 * *"],
    ["0 9 * 6 *", "0 9 * 6 *"],
  ])("describes %s as %s", (cron, words) => {
    expect(describeCronSchedule(inNewYork(cron))).toBe(
      `${words} (America/New_York)`
    );
  });
});
