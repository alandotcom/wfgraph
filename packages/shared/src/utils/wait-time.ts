import {
  normalizeWaitAllowedHoursMode,
  parseTimeOfDayMinutes,
  validateWaitAllowedHoursConfig,
} from "./wait-allowed-hours";

const DURATION_TOKEN_PATTERN = /(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gi;
const ISO_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/i;
const ISO_DURATION_PATTERN =
  /^(-)?P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;
const NUMERIC_VALUE_PATTERN = /^-?\d+(?:\.\d+)?$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;
const NAIVE_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

type WaitTimeResolution = {
  waitUntil?: Date;
  error?: string;
};

function unitToMs(unit: string): number {
  switch (unit) {
    case "ms":
      return 1;
    case "s":
      return 1000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
    case "w":
      return 604_800_000;
    default:
      return Number.NaN;
  }
}

function parseIsoDuration(value: string): number | null {
  const match = ISO_DURATION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const sign = match[1] ? -1 : 1;
  const weeks = Number.parseFloat(match[2] ?? "0");
  const days = Number.parseFloat(match[3] ?? "0");
  const hours = Number.parseFloat(match[4] ?? "0");
  const minutes = Number.parseFloat(match[5] ?? "0");
  const seconds = Number.parseFloat(match[6] ?? "0");

  const ms =
    weeks * unitToMs("w") +
    days * unitToMs("d") +
    hours * unitToMs("h") +
    minutes * unitToMs("m") +
    seconds * unitToMs("s");

  return sign * ms;
}

export function parseDurationMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (NUMERIC_VALUE_PATTERN.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  const isoDurationMs = parseIsoDuration(trimmed);
  if (isoDurationMs !== null) {
    return isoDurationMs;
  }

  let total = 0;
  let matched = false;

  for (const token of trimmed.matchAll(DURATION_TOKEN_PATTERN)) {
    const amount = Number.parseFloat(token[1]);
    const unit = token[2].toLowerCase();
    const factor = unitToMs(unit);

    if (!Number.isFinite(amount) || Number.isNaN(factor)) {
      return null;
    }

    matched = true;
    total += amount * factor;
  }

  return matched ? total : null;
}

function parseNaiveDateTime(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const match = NAIVE_DATETIME_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
    hour: Number.parseInt(match[4] ?? "0", 10),
    minute: Number.parseInt(match[5] ?? "0", 10),
    second: Number.parseInt(match[6] ?? "0", 10),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const mapped = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  const asUtcTimestamp = Date.UTC(
    Number.parseInt(mapped.year, 10),
    Number.parseInt(mapped.month, 10) - 1,
    Number.parseInt(mapped.day, 10),
    Number.parseInt(mapped.hour, 10),
    Number.parseInt(mapped.minute, 10),
    Number.parseInt(mapped.second, 10)
  );

  return asUtcTimestamp - date.getTime();
}

function zonedDateTimeToUtc(value: string, timeZone: string): Date | null {
  const parsed = parseNaiveDateTime(value);
  if (!parsed) {
    return null;
  }

  // First-pass UTC guess from local calendar fields
  const utcGuess = new Date(
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsed.hour,
      parsed.minute,
      parsed.second
    )
  );

  const firstOffset = getTimeZoneOffsetMs(utcGuess, timeZone);
  const firstPass = new Date(utcGuess.getTime() - firstOffset);

  // Second pass to stabilize around DST transitions
  const secondOffset = getTimeZoneOffsetMs(firstPass, timeZone);
  if (secondOffset !== firstOffset) {
    return new Date(utcGuess.getTime() - secondOffset);
  }

  return firstPass;
}

export function parseTimestampWithTimezone(
  value: unknown,
  timeZone?: string
): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    return createValidDate(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return (
    parseEpochTimestamp(trimmed) ??
    parseIsoOffsetTimestamp(trimmed) ??
    parseZonedOrNativeTimestamp(trimmed, timeZone)
  );
}

function createValidDate(value: number | string): Date | null {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseEpochTimestamp(value: string): Date | null {
  if (!DIGITS_ONLY_PATTERN.test(value)) {
    return null;
  }

  const epoch = Number.parseInt(value, 10);
  const millis = value.length <= 10 ? epoch * 1000 : epoch;
  return createValidDate(millis);
}

function parseIsoOffsetTimestamp(value: string): Date | null {
  if (!ISO_OFFSET_PATTERN.test(value)) {
    return null;
  }

  return createValidDate(value);
}

function parseZonedOrNativeTimestamp(
  value: string,
  timeZone?: string
): Date | null {
  if (timeZone) {
    const zoned = zonedDateTimeToUtc(value, timeZone);
    if (zoned) {
      return zoned;
    }
  }

  return createValidDate(value);
}

/**
 * Shift a UTC candidate date into a daily allowed window in the given timezone.
 * If the candidate falls before the window, it shifts to the window start same day.
 * If the candidate falls at or after the window end, it shifts to the window start next day.
 */
export function applyDailyWindow(
  candidate: Date,
  startMinutes: number,
  endMinutes: number,
  timeZone: string
): Date {
  const offset = getTimeZoneOffsetMs(candidate, timeZone);
  const localMs = candidate.getTime() + offset;
  const localDate = new Date(localMs);
  const currentMinutes =
    localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return candidate;
  }

  const startHour = Math.floor(startMinutes / 60);
  const startMinute = startMinutes % 60;
  const dayOffset = currentMinutes < startMinutes ? 0 : 1;

  // Build target local time then convert to UTC with DST stabilization
  const target = new Date(localMs);
  target.setUTCDate(target.getUTCDate() + dayOffset);
  target.setUTCHours(startHour, startMinute, 0, 0);

  const firstPass = new Date(target.getTime() - offset);
  const refinedOffset = getTimeZoneOffsetMs(firstPass, timeZone);
  if (refinedOffset !== offset) {
    return new Date(target.getTime() - refinedOffset);
  }
  return firstPass;
}

/**
 * Apply allowed-hours window enforcement to a candidate date.
 * If mode is "off" or config is invalid, returns the candidate unchanged.
 */
export function applyWaitAllowedHours(input: {
  candidate: Date;
  waitAllowedHoursMode?: unknown;
  waitAllowedStartTime?: unknown;
  waitAllowedEndTime?: unknown;
  timeZone?: string | undefined;
}): { date: Date; error?: string | undefined } {
  const mode = normalizeWaitAllowedHoursMode(input.waitAllowedHoursMode);

  if (mode === "off") {
    return { date: input.candidate };
  }

  const issues = validateWaitAllowedHoursConfig({
    mode,
    startTime: input.waitAllowedStartTime,
    endTime: input.waitAllowedEndTime,
  });

  if (issues.length > 0) {
    return {
      date: input.candidate,
      error: issues.map((i) => i.message).join(" "),
    };
  }

  if (!input.timeZone) {
    return {
      date: input.candidate,
      error: "Timezone is required when allowed-hours window is enabled.",
    };
  }

  const startMinutes = parseTimeOfDayMinutes(input.waitAllowedStartTime);
  const endMinutes = parseTimeOfDayMinutes(input.waitAllowedEndTime);

  if (startMinutes === null || endMinutes === null) {
    return {
      date: input.candidate,
      error: "Invalid allowed-hours time format after validation.",
    };
  }

  return {
    date: applyDailyWindow(
      input.candidate,
      startMinutes,
      endMinutes,
      input.timeZone
    ),
  };
}

export function resolveWaitUntil(input: {
  now?: Date;
  waitUntil?: unknown;
  waitDuration?: unknown;
  waitOffset?: unknown;
  waitTimezone?: string | undefined;
  waitAllowedHoursMode?: unknown;
  waitAllowedStartTime?: unknown;
  waitAllowedEndTime?: unknown;
}): WaitTimeResolution {
  const now = input.now ?? new Date();
  const waitTimezone =
    typeof input.waitTimezone === "string" && input.waitTimezone.trim()
      ? input.waitTimezone.trim()
      : undefined;

  let candidate: Date;

  if (input.waitUntil !== undefined && input.waitUntil !== "") {
    const parsed = parseTimestampWithTimezone(input.waitUntil, waitTimezone);
    if (!parsed) {
      return {
        error: "Invalid waitUntil value. Use an ISO timestamp or unix epoch.",
      };
    }

    const offsetMs = parseDurationMs(input.waitOffset);
    if (
      input.waitOffset !== undefined &&
      input.waitOffset !== "" &&
      offsetMs === null
    ) {
      return {
        error:
          "Invalid waitOffset value. Use duration like -1d, 6h, 30m, or ISO duration.",
      };
    }

    candidate = new Date(parsed.getTime() + (offsetMs ?? 0));
  } else {
    const durationMs = parseDurationMs(input.waitDuration);
    if (durationMs === null) {
      return {
        error:
          "Invalid waitDuration value. Use milliseconds, duration tokens (e.g. 24h), or ISO duration.",
      };
    }

    candidate = new Date(now.getTime() + durationMs);
  }

  // Apply allowed-hours window enforcement
  const windowResult = applyWaitAllowedHours({
    candidate,
    waitAllowedHoursMode: input.waitAllowedHoursMode,
    waitAllowedStartTime: input.waitAllowedStartTime,
    waitAllowedEndTime: input.waitAllowedEndTime,
    timeZone: waitTimezone,
  });

  if (windowResult.error) {
    return { error: windowResult.error };
  }

  return { waitUntil: windowResult.date };
}
