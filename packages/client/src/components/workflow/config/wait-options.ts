/**
 * The labels a Wait step's fields and choices are offered and summarized under.
 * The Wait form and Canvas Reveal's Wait summary both read these, so a field
 * and a choice read the same in both places.
 */

import { WAIT_FIELD_LABELS } from "@wfgraph/shared/actions/wait-field-labels";
import type { WaitConfig } from "@wfgraph/shared/lifecycle/wait-subscription";

export { WAIT_FIELD_LABELS };

export type WaitOption<Value extends string = string> = {
  value: Value;
  label: string;
};

type DescribedWaitOption<Value extends string> = WaitOption<Value> & {
  description: string;
};

export const WAIT_DELAY_TIMING_OPTIONS = [
  { value: "duration", label: WAIT_FIELD_LABELS.waitDuration },
  { value: "until", label: WAIT_FIELD_LABELS.waitUntil },
] as const satisfies readonly WaitOption<"duration" | "until">[];
export const WAIT_GATE_OPTIONS = [
  {
    value: "off",
    label: "Continue immediately",
    description: "If the scheduled time has passed, continue immediately.",
  },
  {
    value: "require_actual_wait",
    label: "End this branch",
    description:
      "If the scheduled time has passed and no wait remains, end this branch.",
  },
  {
    value: "max_lateness",
    label: "Continue within a limit",
    description:
      "Continue only when the scheduled time is within the allowed lateness. Otherwise, end this branch.",
  },
] as const satisfies readonly DescribedWaitOption<
  NonNullable<WaitConfig["waitGateMode"]>
>[];
export const WAIT_WINDOW_OPTIONS = [
  { value: "off", label: "Any time" },
  { value: "daily_window", label: "Only during set hours" },
] as const satisfies readonly WaitOption<"off" | "daily_window">[];
export const WAIT_TIMEOUT_OPTIONS = [
  { value: "continue", label: "Continue to the next step" },
  { value: "skip", label: "End this branch" },
] as const satisfies readonly WaitOption<
  NonNullable<WaitConfig["waitTimeoutBehavior"]>
>[];
export const WAIT_MODE_OPTIONS = [
  { value: "delay", label: "Wait for time" },
  { value: "event", label: "Wait for an event" },
] as const satisfies readonly WaitOption<NonNullable<WaitConfig["waitMode"]>>[];

/** The label of `value` among `options`, or null when none matches. */
export function waitOptionLabel(
  options: readonly WaitOption[],
  value: string
): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}
