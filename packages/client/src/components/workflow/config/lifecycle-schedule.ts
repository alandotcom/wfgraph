/**
 * The Schedule group's model: a row per schedule as the builder edits it, the
 * preset a cron expression reads as, and which rows the stored rules can hold.
 * Rows hold whatever the builder typed, so a row can be invalid; the stored
 * Lifecycle Rules only ever receive a list that `cronSchedulesSchema` accepts.
 */

import { uniq } from "es-toolkit/array";
import {
  clockTime,
  type CronSchedule,
  cronShape,
  describeCronSchedule,
  findScheduleIssue,
  nextFireTimes,
  sameSchedule,
  type ScheduleIssue,
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

/**
 * The fixed time of day an expression names, or undefined for a shape with
 * none, such as an hourly or Custom expression.
 */
export function readClockTime(cron: string): ClockTime | undefined {
  const shape = cronShape(cron);
  switch (shape.kind) {
    case "daily":
    case "weekdays":
    case "weekly":
    case "monthly":
      return { hour: shape.hour, minute: shape.minute };
    default:
      return undefined;
  }
}

/** The single day of week an expression names, as a `WEEKDAYS` value. */
export function readWeekday(cron: string): string | undefined {
  const shape = cronShape(cron);
  return shape.kind === "weekly" ? String(shape.weekday) : undefined;
}

/** The preset whose controls can show this expression, or Custom. */
export function presetOf(cron: string): SchedulePreset {
  const shape = cronShape(cron);
  switch (shape.kind) {
    case "hourly":
    case "daily":
    case "weekdays":
    case "weekly":
      return shape.kind;
    default:
      return "custom";
  }
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

/** What the stored rules hold for a list of rows, from `readScheduleRows`. */
type ScheduleRowsReading = {
  /** The schedules the stored rules hold, in row order. */
  schedules: CronSchedule[];
  /** The schedule each row holds in the stored rules, by row id. */
  savedByRow: ReadonlyMap<string, CronSchedule>;
  /**
   * Why each row the stored rules do not hold as written is left unsaved, in
   * row order. `index` is the row's place in the list.
   */
  unsaved: ScheduleIssue[];
};

/**
 * Which schedules the stored rules hold for `rows`. A row is saved as written
 * when its schedule is valid and no earlier row holds the same one. A row
 * that is not keeps the schedule it last saved, which `lastSaved` maps from
 * its id, so an edit in progress never drops a stored schedule; a new row
 * that is not saved holds nothing.
 */
export function readScheduleRows(
  rows: readonly ScheduleRow[],
  lastSaved: ReadonlyMap<string, CronSchedule>
): ScheduleRowsReading {
  const schedules: CronSchedule[] = [];
  const savedByRow = new Map<string, CronSchedule>();
  const unsaved: ScheduleIssue[] = [];
  const hold = (rowId: string, schedule: CronSchedule) => {
    if (!schedules.some((held) => sameSchedule(held, schedule))) {
      schedules.push(schedule);
      savedByRow.set(rowId, schedule);
    }
  };

  // Traversal state: whether a row is a duplicate depends on what the rows
  // before it hold.
  for (const [index, row] of rows.entries()) {
    const schedule = { cron: row.cron, timeZone: row.timeZone };
    // `schedules` is valid and holds each schedule once, so any issue is
    // about this row.
    const issue = findScheduleIssue([...schedules, schedule]);
    if (issue === undefined) {
      hold(row.id, schedule);
      continue;
    }
    unsaved.push({ ...issue, index });
    const previous = lastSaved.get(row.id);
    if (previous !== undefined) {
      hold(row.id, previous);
    }
  }
  return { schedules, savedByRow, unsaved };
}

/**
 * The sentence the Lifecycle warning shows for a row left unsaved, naming the
 * row as its card is titled.
 */
export function unsavedScheduleMessage(issue: ScheduleIssue): string {
  return issue.index === undefined
    ? issue.message
    : `Schedule ${issue.index + 1} isn't saved. ${issue.message}`;
}

/**
 * A fire time in the schedule's own zone, such as "Mon Nov 9, 9:00 AM". The
 * description beside it names the zone and uses the same 12-hour English clock.
 */
export function formatFireTime(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${clockTime(instant, timeZone)}`;
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
