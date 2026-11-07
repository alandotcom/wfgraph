/**
 * A cron schedule: a 5-field expression read in one IANA time zone. Croner
 * applies its daylight-saving rules (croner.56k.guru/usage/pattern): a fixed-time
 * schedule fires a skipped local time once at the next valid instant and a
 * repeated one once, and an interval schedule runs on elapsed time. Every
 * function is pure over the schedule and the instants it is given.
 */

import { Cron } from "croner";
import { Result, Schema, SchemaIssue } from "effect";
import { uniqBy } from "es-toolkit/array";

const CRON_EXPRESSION_MESSAGE =
  "A schedule needs a cron expression of five fields separated by single spaces: minute, hour, day of month, month and day of week.";

const NEVER_FIRES_MESSAGE =
  "This cron expression names no date that exists, such as February 30, so the schedule would never start a run. Choose a date that occurs.";

const TIME_ZONE_MESSAGE =
  "A schedule needs an IANA time zone, spelled the way IANA spells it, such as America/New_York.";

const DUPLICATE_SCHEDULE_MESSAGE =
  "Two schedules have the same cron expression and time zone. Remove one of them.";

/**
 * Croner reading the expression in a zone. `mode: "5-part"` refuses a seconds
 * or year field, and `paused` keeps croner from arming a timer, since nothing
 * here runs a function.
 */
function croner(cron: string, timeZone: string): Cron {
  return new Cron(cron, { mode: "5-part", timezone: timeZone, paused: true });
}

/** Whether croner reads this as a 5-field expression, written in one spacing. */
function isFiveFieldExpression(cron: string): boolean {
  const fields = cron.split(" ");
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    return false;
  }
  try {
    croner(cron, "UTC");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the expression matches any date at all. A 5-field expression has no
 * year, so one that matches nothing after 1970 matches nothing ever.
 */
function matchesSomeDate(cron: string): boolean {
  return croner(cron, "UTC").nextRun(new Date(0)) !== null;
}

/**
 * Whether `Intl` knows the zone by this spelling. A UTC offset such as `+05:00`
 * is refused, since it is not an IANA name and follows no daylight-saving rule.
 * A spelling differing only in letter case from the one `Intl` reports is
 * refused too, because a schedule is identified by its exact zone string.
 */
function isIanaTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z]/.test(timeZone)) {
    return false;
  }
  try {
    const resolved = new Intl.DateTimeFormat("en-US", {
      timeZone,
    }).resolvedOptions().timeZone;
    return (
      resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * A 5-field cron expression that matches at least one date. Standard Vixie
 * cron syntax: a day of month and a day of week both restricted match either.
 */
const cronExpressionSchema = Schema.String.annotate({
  message: CRON_EXPRESSION_MESSAGE,
})
  .check(
    Schema.makeFilter((cron: string) => {
      if (!isFiveFieldExpression(cron)) {
        return CRON_EXPRESSION_MESSAGE;
      }
      return matchesSomeDate(cron) ? undefined : NEVER_FIRES_MESSAGE;
    })
  )
  .annotateKey({ messageMissingKey: CRON_EXPRESSION_MESSAGE });

const timeZoneSchema = Schema.String.annotate({ message: TIME_ZONE_MESSAGE })
  .check(
    Schema.makeFilter((timeZone: string) =>
      isIanaTimeZone(timeZone) ? undefined : TIME_ZONE_MESSAGE
    )
  )
  .annotateKey({ messageMissingKey: TIME_ZONE_MESSAGE });

/**
 * One schedule. The pair of `cron` and `timeZone` is its identity, which is
 * what the timer row behind it is keyed by.
 */
const cronScheduleSchema = Schema.Struct({
  cron: cronExpressionSchema,
  timeZone: timeZoneSchema,
});

export type CronSchedule = typeof cronScheduleSchema.Type;

/** A schedule's identity, its expression and zone, as one string key. */
export function scheduleIdentity(schedule: CronSchedule): string {
  return JSON.stringify([schedule.cron, schedule.timeZone]);
}

/** Whether two schedules are the same schedule: the same expression in the same zone. */
export function sameSchedule(left: CronSchedule, right: CronSchedule): boolean {
  return left.cron === right.cron && left.timeZone === right.timeZone;
}

/** A workflow's schedules, each identity at most once. */
export const cronSchedulesSchema = Schema.Array(cronScheduleSchema).check(
  Schema.makeFilter((schedules: readonly CronSchedule[]) =>
    uniqBy(schedules, scheduleIdentity).length === schedules.length
      ? undefined
      : DUPLICATE_SCHEDULE_MESSAGE
  )
);

/**
 * The first reason a save refuses a list of schedules: its sentence, and the
 * index and field of the schedule it is about. A duplicate names neither.
 */
export type ScheduleIssue = {
  message: string;
  index: number | undefined;
  field: "cron" | "timeZone" | undefined;
};

const decodeSchedules = Schema.decodeUnknownResult(cronSchedulesSchema);
const formatScheduleIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Why a save would refuse `schedules`, or undefined when it accepts them. */
export function findScheduleIssue(
  schedules: readonly CronSchedule[]
): ScheduleIssue | undefined {
  const decoded = decodeSchedules(schedules);
  if (Result.isSuccess(decoded)) {
    return undefined;
  }
  const [issue] = formatScheduleIssues(decoded.failure.issue).issues;
  const [index, field] = issue.path ?? [];
  return {
    message: issue.message,
    index: typeof index === "number" ? index : undefined,
    field: field === "cron" || field === "timeZone" ? field : undefined,
  };
}

/**
 * The first fire time strictly after `after`, or undefined when the expression
 * matches no later date.
 */
export function nextFireAfter(
  schedule: CronSchedule,
  after: Date
): Date | undefined {
  return croner(schedule.cron, schedule.timeZone).nextRun(after) ?? undefined;
}

/** The next `count` fire times after `after`, fewer where the expression runs out. */
export function nextFireTimes(
  schedule: CronSchedule,
  after: Date,
  count: number
): Date[] {
  return croner(schedule.cron, schedule.timeZone).nextRuns(count, after);
}

/**
 * The most recent fire time at or before `at`, which is the slot a late claim
 * fires for. Undefined when the expression matched no earlier date.
 *
 * Croner's previous run is strictly before a reference it reads in whole
 * seconds. Slots fall on whole minutes, so a reference one second past `at`
 * adds a slot falling exactly on `at` and no other.
 */
export function latestSlotAtOrBefore(
  schedule: CronSchedule,
  at: Date
): Date | undefined {
  const [slot] = croner(schedule.cron, schedule.timeZone).previousRuns(
    1,
    new Date(at.getTime() + 1000)
  );
  return slot;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * A cron field holding one plain number from `min` to `max`, or undefined for
 * anything else, such as a wildcard, a step, a range or a list.
 */
export function cronFieldNumber(
  field: string,
  min: number,
  max: number
): number | undefined {
  if (!/^\d{1,2}$/.test(field)) {
    return undefined;
  }
  const value = Number(field);
  return value >= min && value <= max ? value : undefined;
}

/** A 12-hour clock time, such as 9:00 AM or 12:30 PM. */
function clockTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hourOnDial = hour % 12 === 0 ? 12 : hour % 12;
  return `${hourOnDial}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * The expression in words for the shapes a schedule picker offers, and the
 * expression itself for anything else.
 */
function describeExpression(cron: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(" ");
  if (month !== "*") {
    return cron;
  }
  const everyDay = dayOfMonth === "*" && dayOfWeek === "*";

  if (hour === "*" && everyDay) {
    if (minute === "*") {
      return "Every minute";
    }
    const step = /^\*\/(\d+)$/.exec(minute)?.[1];
    if (step) {
      return step === "1" ? "Every minute" : `Every ${step} minutes`;
    }
    const minuteOfHour = cronFieldNumber(minute, 0, 59);
    return minuteOfHour === undefined
      ? cron
      : `Every hour at :${String(minuteOfHour).padStart(2, "0")}`;
  }

  const minuteOfHour = cronFieldNumber(minute, 0, 59);
  const hourOfDay = cronFieldNumber(hour, 0, 23);
  if (minuteOfHour === undefined || hourOfDay === undefined) {
    return cron;
  }
  const time = clockTime(hourOfDay, minuteOfHour);

  if (everyDay) {
    return `Every day at ${time}`;
  }
  if (dayOfMonth === "*") {
    if (dayOfWeek === "1-5") {
      return `Every weekday at ${time}`;
    }
    const weekday = cronFieldNumber(dayOfWeek, 0, 7);
    return weekday === undefined
      ? cron
      : `Every ${WEEKDAY_NAMES[weekday % 7]} at ${time}`;
  }
  const day = cronFieldNumber(dayOfMonth, 1, 31);
  return day !== undefined && dayOfWeek === "*"
    ? `On day ${day} of every month at ${time}`
    : cron;
}

/**
 * The schedule in words with its zone, such as "Every weekday at 9:00 AM
 * (America/New_York)". An expression outside the described shapes is shown as
 * written.
 */
export function describeCronSchedule(schedule: CronSchedule): string {
  return `${describeExpression(schedule.cron)} (${schedule.timeZone})`;
}
