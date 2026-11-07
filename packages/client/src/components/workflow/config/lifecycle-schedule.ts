/**
 * The Schedule group's model: a row per schedule as the builder edits it, the
 * preset a cron expression reads as, and the refusal a list of rows earns.
 * Rows hold whatever the builder typed, so a row can be invalid; the stored
 * Lifecycle Rules only ever receive a list that `cronSchedulesSchema` accepts.
 */

import { uniq } from "es-toolkit/array";
import {
  type CronSchedule,
  cronFieldNumber,
  describeCronSchedule,
  findScheduleIssue,
  nextFireTimes,
  scheduleIdentity,
} from "@wfgraph/shared/lifecycle/cron-schedule";

export type SchedulePreset =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export const SCHEDULE_PRESETS: ReadonlyArray<{
  value: SchedulePreset;
  label: string;
}> = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day at" },
  { value: "weekdays", label: "Every weekday at" },
  { value: "weekly", label: "Every week on" },
  { value: "custom", label: "Custom" },
];

/** Day-of-week field values in the order a week reads, Monday first. */
export const WEEKDAYS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

/**
 * One schedule as the group edits it. `id` keys the row while the builder edits
 * it, and `preset` is the shape the controls show, which a Custom row keeps
 * even when its expression happens to match a preset.
 */
export type ScheduleRow = {
  id: string;
  preset: SchedulePreset;
  cron: string;
  timeZone: string;
};

/** A clock time on a 24-hour dial, as an `<input type="time">` reads it. */
type ClockTime = { hour: number; minute: number };

const DEFAULT_TIME: ClockTime = { hour: 9, minute: 0 };
const DEFAULT_WEEKDAY = "1";

/** The fixed minute and hour of an expression, or undefined when either varies. */
export function readClockTime(cron: string): ClockTime | undefined {
  const [minute, hour] = cron.split(" ");
  const minuteOfHour = cronFieldNumber(minute, 0, 59);
  const hourOfDay = cronFieldNumber(hour, 0, 23);
  return minuteOfHour === undefined || hourOfDay === undefined
    ? undefined
    : { hour: hourOfDay, minute: minuteOfHour };
}

/** The single day of week an expression names, as a `WEEKDAYS` value. */
export function readWeekday(cron: string): string | undefined {
  const day = cronFieldNumber(cron.split(" ")[4], 0, 7);
  return day === undefined ? undefined : String(day % 7);
}

/** The preset whose controls can show this expression, or Custom. */
export function presetOf(cron: string): SchedulePreset {
  const fields = cron.split(" ");
  if (fields.length !== 5) {
    return "custom";
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== "*" || month !== "*") {
    return "custom";
  }
  if (hour === "*" && dayOfWeek === "*") {
    return cronFieldNumber(minute, 0, 59) === undefined ? "custom" : "hourly";
  }
  if (readClockTime(cron) === undefined) {
    return "custom";
  }
  if (dayOfWeek === "*") {
    return "daily";
  }
  if (dayOfWeek === "1-5") {
    return "weekdays";
  }
  return readWeekday(cron) === undefined ? "custom" : "weekly";
}

/**
 * The expression a preset writes. A preset carries over the time and weekday
 * the row already names, and starts from 9:00 AM on Monday where it names none.
 */
export function cronForPreset(input: {
  preset: Exclude<SchedulePreset, "custom">;
  time?: ClockTime | undefined;
  weekday?: string | undefined;
}): string {
  const { hour, minute } = input.time ?? DEFAULT_TIME;
  const expressions: Record<Exclude<SchedulePreset, "custom">, string> = {
    hourly: `${input.time?.minute ?? 0} * * * *`,
    daily: `${minute} ${hour} * * *`,
    weekdays: `${minute} ${hour} * * 1-5`,
    weekly: `${minute} ${hour} * * ${input.weekday ?? DEFAULT_WEEKDAY}`,
  };
  return expressions[input.preset];
}

/** The row after the builder picks another preset. */
export function withPreset(
  row: ScheduleRow,
  preset: SchedulePreset
): ScheduleRow {
  if (preset === "custom") {
    return { ...row, preset };
  }
  return {
    ...row,
    preset,
    cron: cronForPreset({
      preset,
      time: readClockTime(row.cron),
      weekday: readWeekday(row.cron),
    }),
  };
}

/** The row after the builder sets a time or a weekday on a preset. */
export function withPresetFields(
  row: ScheduleRow,
  fields: { time?: ClockTime | undefined; weekday?: string | undefined }
): ScheduleRow {
  if (row.preset === "custom") {
    return row;
  }
  return {
    ...row,
    cron: cronForPreset({
      preset: row.preset,
      time: fields.time ?? readClockTime(row.cron),
      weekday: fields.weekday ?? readWeekday(row.cron),
    }),
  };
}

/** `09:05` for an `<input type="time">`, or empty when the time varies. */
export function timeInputValue(cron: string): string {
  const time = readClockTime(cron);
  return time
    ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`
    : "";
}

/** The clock time an `<input type="time">` holds, or undefined while it is blank. */
export function parseTimeInput(value: string): ClockTime | undefined {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return undefined;
  }
  const time = { hour: Number(match[1]), minute: Number(match[2]) };
  return time.hour <= 23 && time.minute <= 59 ? time : undefined;
}

/** A stored schedule as a row, keyed by its identity, which a list holds once. */
export function rowOfSchedule(schedule: CronSchedule): ScheduleRow {
  return {
    id: scheduleIdentity(schedule),
    preset: presetOf(schedule.cron),
    cron: schedule.cron,
    timeZone: schedule.timeZone,
  };
}

/** The schedules the rows stand for, in the shape the Lifecycle Rules store. */
export function schedulesOfRows(rows: readonly ScheduleRow[]): CronSchedule[] {
  return rows.map((row) => ({ cron: row.cron, timeZone: row.timeZone }));
}

/**
 * Why a save would refuse these rows: the sentence, and the row and field it
 * names when the refusal is about one row. A duplicate names no row.
 */
export type ScheduleRefusal = {
  message: string;
  rowIndex: number | undefined;
  field: "cron" | "timeZone" | undefined;
};

/** The first refusal these rows earn, or undefined when a save accepts them. */
export function scheduleRefusalOf(
  rows: readonly ScheduleRow[]
): ScheduleRefusal | undefined {
  const issue = findScheduleIssue(schedulesOfRows(rows));
  return issue === undefined
    ? undefined
    : { message: issue.message, rowIndex: issue.index, field: issue.field };
}

/** Whether one row on its own is a schedule a save accepts. */
export function isValidRow(row: ScheduleRow): boolean {
  return findScheduleIssue(schedulesOfRows([row])) === undefined;
}

/**
 * A fire time in the schedule's own zone, such as "Mon Nov 9, 9:00 AM". The
 * description beside it names the zone and uses this 12-hour English clock.
 */
export function formatFireTime(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/** The schedule in words with its next `count` fire times after `now`. */
export function scheduleReadout(
  schedule: CronSchedule,
  now: Date,
  count: number
): { description: string; nextFires: string[] } {
  return {
    description: describeCronSchedule(schedule),
    nextFires: nextFireTimes(schedule, now, count).map((instant) =>
      formatFireTime(instant, schedule.timeZone)
    ),
  };
}

/**
 * Every IANA zone the browser knows, with `current` added when the browser
 * lists it under another spelling. `Intl` leaves UTC out of its list.
 */
export function timeZoneChoices(current: readonly string[]): string[] {
  return uniq([
    "UTC",
    ...Intl.supportedValuesOf("timeZone"),
    ...current,
  ]).toSorted();
}

/** The zone this browser runs in, which a new schedule starts with. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A search for a zone reads spaces and underscores alike: "new york". */
export function matchesTimeZone(zone: string, query: string): boolean {
  const needle = query.trim().toLowerCase().replaceAll(" ", "_");
  return needle.length === 0 || zone.toLowerCase().includes(needle);
}
