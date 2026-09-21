/** The user-facing label of each built-in Wait configuration field. */
export const WAIT_FIELD_LABELS = {
  waitMode: "How should this step wait?",
  waitDelayTimingMode: "Time source",
  waitDuration: "Duration",
  waitUntil: "Date and time",
  waitOffset: "Adjust time (optional)",
  waitGateMode: "If the scheduled time has passed",
  waitMaxLateness: "Continue if late by up to",
  waitAllowedHoursMode: "Allowed hours",
  waitAllowedStartTime: "Start time",
  waitAllowedEndTime: "End time",
  waitTimezone: "Timezone",
  waitTimeout: "Stop waiting after",
  waitTimeoutBehavior: "When time runs out",
} as const;
