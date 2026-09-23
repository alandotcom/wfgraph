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

type WaitTargetInput = {
  now?: Date;
  waitUntil?: unknown;
  waitDuration?: unknown;
  waitOffset?: unknown;
  waitTimezone?: string | undefined;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
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

export function parsePositiveDurationMs(value: unknown): number | null {
  const durationMs = parseDurationMs(value);
  return durationMs !== null && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : null;
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

function getLocalDateTime(date: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const mapped = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return {
    year: Number.parseInt(mapped.year, 10),
    month: Number.parseInt(mapped.month, 10),
    day: Number.parseInt(mapped.day, 10),
    hour: Number.parseInt(mapped.hour, 10),
    minute: Number.parseInt(mapped.minute, 10),
    second: Number.parseInt(mapped.second, 10),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const local = getLocalDateTime(date, timeZone);
  const asUtcTimestamp = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );

  return asUtcTimestamp - Math.floor(date.getTime() / 1000) * 1000;
}

function compareLocalDateTime(
  left: LocalDateTime,
  right: LocalDateTime
): number {
  const fields = ["year", "month", "day", "hour", "minute", "second"] as const;

  for (const field of fields) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }

  return 0;
}

function firstInstantAfterOffsetChange(input: {
  before: Date;
  after: Date;
  previousOffset: number;
  timeZone: string;
}): Date {
  let low = Math.floor(input.before.getTime() / 1000) * 1000;
  let high = Math.floor(input.after.getTime() / 1000) * 1000;

  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (
      getTimeZoneOffsetMs(new Date(middle), input.timeZone) ===
      input.previousOffset
    ) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return new Date(high);
}

function resolveLocalDateTime(
  parsed: LocalDateTime,
  timeZone: string,
  offsetGuess?: number
): Date {
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

  const firstOffset = offsetGuess ?? getTimeZoneOffsetMs(utcGuess, timeZone);
  const firstPass = new Date(utcGuess.getTime() - firstOffset);

  // Second pass to stabilize around DST transitions
  const secondOffset = getTimeZoneOffsetMs(firstPass, timeZone);
  if (secondOffset !== firstOffset) {
    const adjusted = new Date(utcGuess.getTime() - secondOffset);
    const adjustedComparison = compareLocalDateTime(
      getLocalDateTime(adjusted, timeZone),
      parsed
    );
    const firstPassComparison = compareLocalDateTime(
      getLocalDateTime(firstPass, timeZone),
      parsed
    );

    const targetIsBetweenCandidates =
      (adjustedComparison < 0 && firstPassComparison > 0) ||
      (firstPassComparison < 0 && adjustedComparison > 0);
    if (targetIsBetweenCandidates) {
      const before =
        adjusted.getTime() < firstPass.getTime() ? adjusted : firstPass;
      const after = before === adjusted ? firstPass : adjusted;

      // The requested wall time is in a forward clock gap. Return the first
      // instant after the offset changes; leave fold resolution on the existing
      // two-pass path.
      return firstInstantAfterOffsetChange({
        before,
        after,
        previousOffset: getTimeZoneOffsetMs(before, timeZone),
        timeZone,
      });
    }

    return adjusted;
  }

  return firstPass;
}

function zonedDateTimeToUtc(value: string, timeZone: string): Date | null {
  const parsed = parseNaiveDateTime(value);
  if (!parsed) {
    return null;
  }

  return resolveLocalDateTime(parsed, timeZone);
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

  // A nonexistent start can move forward through a DST gap. Keep advancing the
  // local date until that first valid instant is still inside the window.
  const target = new Date(localMs);
  target.setUTCDate(target.getUTCDate() + dayOffset);

  for (;;) {
    target.setUTCHours(startHour, startMinute, 0, 0);
    const requested = {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      hour: startHour,
      minute: startMinute,
      second: 0,
    };
    const resolved = resolveLocalDateTime(requested, timeZone, offset);
    const actual = getLocalDateTime(resolved, timeZone);
    const actualMinutes = actual.hour * 60 + actual.minute;
    const sameLocalDate =
      actual.year === requested.year &&
      actual.month === requested.month &&
      actual.day === requested.day;

    if (
      sameLocalDate &&
      actualMinutes >= startMinutes &&
      actualMinutes < endMinutes &&
      resolved.getTime() >= candidate.getTime()
    ) {
      return resolved;
    }

    target.setUTCDate(target.getUTCDate() + 1);
  }
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

/** Resolve the authored target and offset before allowed-hours adjustment. */
export function resolveWaitTarget(input: WaitTargetInput): WaitTimeResolution {
  const now = input.now ?? new Date();
  // Match the editor's visible default when a naive timestamp has no zone key.
  const waitTimezone =
    typeof input.waitTimezone === "string" && input.waitTimezone.trim()
      ? input.waitTimezone.trim()
      : "UTC";

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

    return { waitUntil: new Date(parsed.getTime() + (offsetMs ?? 0)) };
  }

  const durationMs = parseDurationMs(input.waitDuration);
  if (durationMs === null) {
    return {
      error:
        "Invalid waitDuration value. Use milliseconds, duration tokens (e.g. 24h), or ISO duration.",
    };
  }

  return { waitUntil: new Date(now.getTime() + durationMs) };
}

export function resolveWaitUntil(
  input: WaitTargetInput & {
    waitAllowedHoursMode?: unknown;
    waitAllowedStartTime?: unknown;
    waitAllowedEndTime?: unknown;
  }
): WaitTimeResolution {
  const target = resolveWaitTarget(input);
  if (!target.waitUntil) {
    return target;
  }

  const waitTimezone =
    typeof input.waitTimezone === "string" && input.waitTimezone.trim()
      ? input.waitTimezone.trim()
      : undefined;
  const windowResult = applyWaitAllowedHours({
    candidate: target.waitUntil,
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
