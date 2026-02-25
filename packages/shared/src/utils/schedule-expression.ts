const DAILY_PATTERN = /^(?:every\s+day|everyday|daily)\s+at\s+(.+)$/i;
const WEEKDAY_PATTERN = /^every\s+weekday\s+at\s+(.+)$/i;
const WEEKLY_PATTERN =
  /^every(?:\s+week(?:\s+on)?)?\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(.+)$/i;
const TIME_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i;

const DAY_TO_CRON: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

type ParsedClockTime = {
  hour: number;
  minute: number;
};

export type ScheduleExpressionParseResult = {
  cron: string;
  source: "cron" | "natural-language";
};

function parseClockTime(value: string): ParsedClockTime | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const rawHour = Number.parseInt(match[1], 10);
  const rawMinute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = match[3]?.toLowerCase().replaceAll(".", "");

  if (rawMinute < 0 || rawMinute > 59) {
    return null;
  }

  if (meridiem === "am" || meridiem === "pm") {
    if (rawHour < 1 || rawHour > 12) {
      return null;
    }

    let hour = rawHour;
    if (meridiem === "am") {
      hour = rawHour % 12;
    } else if (rawHour !== 12) {
      hour = rawHour + 12;
    }

    return { hour, minute: rawMinute };
  }

  if (rawHour < 0 || rawHour > 23) {
    return null;
  }

  return { hour: rawHour, minute: rawMinute };
}

function toCronForDay(time: ParsedClockTime, dayOfWeek: string): string | null {
  const day = DAY_TO_CRON[dayOfWeek.toLowerCase()];
  if (day === undefined) {
    return null;
  }

  return `${time.minute} ${time.hour} * * ${day}`;
}

function parseNaturalLanguageSchedule(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const dailyMatch = DAILY_PATTERN.exec(trimmed);
  if (dailyMatch) {
    const time = parseClockTime(dailyMatch[1]);
    return time ? `${time.minute} ${time.hour} * * *` : null;
  }

  const weekdayMatch = WEEKDAY_PATTERN.exec(trimmed);
  if (weekdayMatch) {
    const time = parseClockTime(weekdayMatch[1]);
    return time ? `${time.minute} ${time.hour} * * 1-5` : null;
  }

  const weeklyMatch = WEEKLY_PATTERN.exec(trimmed);
  if (weeklyMatch) {
    const time = parseClockTime(weeklyMatch[2]);
    return time ? toCronForDay(time, weeklyMatch[1]) : null;
  }

  return null;
}

export function parseScheduleExpression(
  value: unknown
): ScheduleExpressionParseResult | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const naturalCron = parseNaturalLanguageSchedule(trimmed);
  if (naturalCron) {
    return { cron: naturalCron, source: "natural-language" };
  }

  return { cron: trimmed, source: "cron" };
}
