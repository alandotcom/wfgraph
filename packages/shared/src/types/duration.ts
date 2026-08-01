/**
 * A duration is a length of time, written the way a builder writes one.
 *
 * The project reads three spellings, and `parseDurationMs` owns which: a count
 * of milliseconds, tokens like `24h` or `90m`, and an ISO 8601 duration like
 * `P1D`. This file is the schema side of that one grammar, so a field an Event
 * Author declares as a duration accepts exactly what a wait can act on.
 */

import { Schema } from "effect";
import { parseDurationMs } from "#src/utils/wait-time";

/**
 * A duration field, for a schema written in Effect.
 *
 * `format: "duration"` is the whole of how the editor learns a field is a length
 * of time, which is what puts it in the menu a wait's duration input opens.
 */
export function durationString(description?: string) {
  return Schema.String.annotate({ description, format: "duration" }).check(
    Schema.makeFilter((value: string) => parseDurationMs(value) !== null, {
      expected: "a duration, like 24h, 90m, 3600000, or P1D",
    })
  );
}
