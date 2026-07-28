/**
 * A timestamp has two forms in this project.
 *
 * On the wire it is an ISO 8601 string: a field in a webhook body, a value the
 * condition builder saved into node config, a payload that crosses a durable
 * step boundary and comes back on replay. In memory it is a `Date`, because
 * every consumer that compares, offsets or sleeps until a timestamp needs one.
 *
 * This file owns the conversion between those two forms, so the project has a
 * single answer to "which strings count as a timestamp" and a single place to
 * change it.
 */

import { Option, Schema, SchemaTransformation } from "effect";

/**
 * Which strings count, spelled out.
 *
 * The calendar is part of the pattern, not an afterthought: February gets 29
 * days only in a leap year, April gets 30, and a month number above 12 never
 * matches. That is what turns `2026-02-30T10:00:00Z` away, and it is why this
 * is a hand-written pattern rather than one of Effect's date schemas, all of
 * which hand the string to `new Date(...)` and accept whatever it makes of it.
 *
 * The zone is required, either `Z` or a numeric offset. A string without one
 * (`2026-03-01T10:00:00`) names a different instant on every machine that reads
 * it, and both sides of this conversion outlive the process that wrote them: a
 * wait target is read back by whichever worker resumes the run, and a stored
 * condition is compared against payloads from anywhere. A bare date
 * (`2026-03-01`) is turned away for the same reason. Seconds and a fractional
 * part are each optional.
 */
const ISO_TIMESTAMP_PATTERN = new RegExp(
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29" +
    "|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])" +
    "|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)" +
    "|(?:02)-(?:0[1-9]|1\\d|2[0-8])))" +
    "T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?" +
    "(?:Z|(?:[+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
);

/**
 * The wire form paired with the in-memory form: decode reads a string into a
 * `Date`, encode writes a `Date` back out.
 *
 * The `Date` side rejects an invalid `Date`, so a value built from unparseable
 * text is caught here rather than serialized as the string "Invalid Date" and
 * carried somewhere far from its origin.
 */
export const isoTimestampToDate = Schema.String.check(
  Schema.isPattern(ISO_TIMESTAMP_PATTERN)
).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString));

const decodeTimestamp = Schema.decodeOption(isoTimestampToDate);
const decodeTimestampOrThrow = Schema.decodeSync(isoTimestampToDate);
const encodeTimestamp = Schema.encodeSync(isoTimestampToDate);

/**
 * Read a timestamp that arrived as text, answering `null` when the text is not
 * one.
 *
 * This is the form for a caller that has somewhere to go when the value does
 * not parse: a validator reporting the field, a CEL context leaving the value
 * as it found it. A caller with no such path takes `decodeIsoTimestampOrThrow`
 * below.
 */
export function decodeIsoTimestamp(value: string): Date | null {
  return Option.getOrNull(decodeTimestamp(value.trim()));
}

/**
 * The same read for a caller that has nowhere to go: it throws rather than
 * answer.
 *
 * A wait target read back out of a memoized step went in through this module's
 * own codec, so text that will not decode means the value was corrupted in
 * between, and there is no sensible instant to carry on with.
 *
 * Surrounding whitespace is trimmed here exactly as `decodeIsoTimestamp` trims
 * it, because a project with two answers to "is this a timestamp" has none.
 */
export function decodeIsoTimestampOrThrow(value: string): Date {
  return decodeTimestampOrThrow(value.trim());
}

/**
 * Write a `Date` back to its wire form.
 *
 * Throws on a `Date` that carries no time, which is the case worth catching:
 * `.toISOString()` would have produced the literal text "Invalid Date" and let
 * it travel into a log, a table or a response.
 */
export function encodeIsoTimestamp(value: Date): string {
  return encodeTimestamp(value);
}
