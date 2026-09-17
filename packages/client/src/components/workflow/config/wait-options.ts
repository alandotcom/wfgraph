/**
 * The labels a Wait step's fields and choices are offered and summarized under.
 * The Wait form and Canvas Reveal's Wait summary both read these, so a field
 * and a choice read the same in both places.
 */

export type WaitOption = { value: string; label: string };

/** The label of each Wait config key, as its form field shows it. */
export const WAIT_FIELD_LABELS = {
  waitMode: "How should this step wait?",
  waitDelayTimingMode: "Time input mode",
  waitDuration: "Wait for (duration)",
  waitUntil: "Wait until this date/time",
  waitOffset: "Send before/after that time (optional)",
  waitGateMode: "Continue only if time actually elapsed",
  waitAllowedHoursMode: "Allowed send window",
  waitAllowedStartTime: "Window start",
  waitAllowedEndTime: "Window end",
  waitTimezone: "Timezone",
  waitTimeout: "Stop waiting after",
  waitTimeoutBehavior: "On timeout",
} as const;

export const WAIT_DELAY_TIMING_OPTIONS: WaitOption[] = [
  { value: "duration", label: "Wait for duration" },
  { value: "until", label: "Wait until date/time" },
];
export const WAIT_GATE_OPTIONS: WaitOption[] = [
  { value: "off", label: "Off (continue immediately)" },
  { value: "require_actual_wait", label: "Skip branch when already due" },
];
export const WAIT_WINDOW_OPTIONS: WaitOption[] = [
  { value: "off", label: "Off (allow any time)" },
  { value: "daily_window", label: "Daily window" },
];
export const WAIT_TIMEOUT_OPTIONS: WaitOption[] = [
  { value: "continue", label: "Continue workflow" },
  { value: "skip", label: "Skip remaining branch" },
];
export const WAIT_MODE_OPTIONS: WaitOption[] = [
  { value: "delay", label: "Wait for time" },
  { value: "event", label: "Wait for an event" },
];

/** The label of `value` among `options`, or null when none matches. */
export function waitOptionLabel(
  options: readonly WaitOption[],
  value: string
): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}
