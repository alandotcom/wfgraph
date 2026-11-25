/**
 * A Wait's duration read back as words, so a builder sees what the step will
 * do with what they typed: "24h" reads "1 day", and "10s1d" reads "1 day 10
 * seconds". The stored value keeps the notation the builder wrote; this module
 * only reads it.
 */

import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";

const UNITS = [
  { ms: 604_800_000, one: "week", many: "weeks" },
  { ms: 86_400_000, one: "day", many: "days" },
  { ms: 3_600_000, one: "hour", many: "hours" },
  { ms: 60_000, one: "minute", many: "minutes" },
  { ms: 1000, one: "second", many: "seconds" },
  { ms: 1, one: "millisecond", many: "milliseconds" },
] as const;

/**
 * `ms` as whole units from weeks down to milliseconds, largest first, such as
 * "1 week 2 days" or "2 hours 30 minutes". Units the duration does not use are
 * left out. Expects a positive number; a fraction of a millisecond is dropped.
 */
export function durationInWords(ms: number): string {
  let rest = Math.floor(ms);
  const parts: string[] = [];
  for (const unit of UNITS) {
    const count = Math.floor(rest / unit.ms);
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? unit.one : unit.many}`);
      rest -= count * unit.ms;
    }
  }
  return parts.join(" ");
}

/**
 * The sentence a Wait's duration reads back as: "Waits 1 day." for a value a
 * wait can act on, and "Does not wait." for zero or less. Null for blank text,
 * a template reference only a run can resolve, and text no wait can read,
 * which the field marks invalid instead.
 */
export function waitDurationReadback(value: string): string | null {
  if (findTemplateTokens(value).length > 0) {
    return null;
  }
  const ms = parseDurationMs(value);
  if (ms === null) {
    return null;
  }
  return ms >= 1 ? `Waits ${durationInWords(ms)}.` : "Does not wait.";
}
