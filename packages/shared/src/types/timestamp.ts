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

import { z } from "zod";

/**
 * The wire form paired with the in-memory form: decode reads a string into a
 * `Date`, encode writes a `Date` back out.
 *
 * The string side demands an explicit zone, either `Z` or a numeric offset.
 * A string without one (`2026-03-01T10:00:00`) names a different instant on
 * every machine that reads it, and both sides of this conversion outlive the
 * process that wrote them: a wait target is read back by whichever worker
 * resumes the run, and a stored condition is compared against payloads from
 * anywhere. A bare date (`2026-03-01`) is turned away for the same reason.
 *
 * The `Date` side rejects an invalid `Date`, so a value built from unparseable
 * text is caught here rather than serialized as the string "Invalid Date" and
 * carried somewhere far from its origin.
 */
export const isoTimestampToDate = z.codec(
  z.iso.datetime({ offset: true }),
  z.date(),
  {
    decode: (isoString) => new Date(isoString),
    encode: (date) => date.toISOString(),
  }
);

/**
 * Read a timestamp that arrived as text, answering `null` when the text is not
 * one.
 *
 * This is the form for a caller that has somewhere to go when the value does
 * not parse: a validator reporting the field, a CEL context leaving the value
 * as it found it. A caller with no such path should use
 * `z.decode(isoTimestampToDate, value)`, which throws.
 */
export function decodeIsoTimestamp(value: string): Date | null {
  const result = z.safeDecode(isoTimestampToDate, value.trim());
  return result.success ? result.data : null;
}

/**
 * Write a `Date` back to its wire form.
 *
 * Throws on a `Date` that carries no time, which is the case worth catching:
 * `.toISOString()` would have produced the literal text "Invalid Date" and let
 * it travel into a log, a table or a response.
 */
export function encodeIsoTimestamp(value: Date): string {
  return z.encode(isoTimestampToDate, value);
}
