export const WAIT_ALLOWED_HOURS_MODES = ["off", "daily_window"] as const;

export type WaitAllowedHoursMode = (typeof WAIT_ALLOWED_HOURS_MODES)[number];

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type WaitAllowedHoursValidationIssue = {
  field: "mode" | "start" | "end" | "window";
  message: string;
};

export function normalizeWaitAllowedHoursMode(
  value: unknown
): WaitAllowedHoursMode {
  if (typeof value !== "string") {
    return "off";
  }

  const trimmed = value.trim();
  return trimmed === "daily_window" ? "daily_window" : "off";
}

export function parseTimeOfDayMinutes(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = TIME_OF_DAY_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, hours, minutes] = match;
  if (!(hours && minutes)) {
    return null;
  }

  return Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
}

export function validateWaitAllowedHoursConfig(input: {
  mode: unknown;
  startTime: unknown;
  endTime: unknown;
}): WaitAllowedHoursValidationIssue[] {
  const issues: WaitAllowedHoursValidationIssue[] = [];
  const modeValue =
    typeof input.mode === "string"
      ? input.mode.trim()
      : normalizeWaitAllowedHoursMode(input.mode);

  if (
    modeValue.length > 0 &&
    modeValue !== "off" &&
    modeValue !== "daily_window"
  ) {
    issues.push({
      field: "mode",
      message: 'Allowed-hours mode must be either "off" or "daily_window".',
    });
    return issues;
  }

  if (modeValue !== "daily_window") {
    return issues;
  }

  const startMinutes = parseTimeOfDayMinutes(input.startTime);
  if (startMinutes === null) {
    issues.push({
      field: "start",
      message: "Allowed-hours start must use HH:MM (24-hour) format.",
    });
  }

  const endMinutes = parseTimeOfDayMinutes(input.endTime);
  if (endMinutes === null) {
    issues.push({
      field: "end",
      message: "Allowed-hours end must use HH:MM (24-hour) format.",
    });
  }

  if (
    startMinutes !== null &&
    endMinutes !== null &&
    startMinutes >= endMinutes
  ) {
    issues.push({
      field: "window",
      message:
        "Allowed-hours start must be earlier than end (same-day window only).",
    });
  }

  return issues;
}
