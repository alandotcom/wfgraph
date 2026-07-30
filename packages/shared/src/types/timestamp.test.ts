import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { requireOutputFieldsFromSchema } from "#src/workflow/output-fields";
import {
  dateField,
  decodeIsoTimestamp,
  decodeIsoTimestampOrThrow,
  encodeIsoTimestamp,
  isoTimestampToDate,
  timestampField,
} from "#src/types/timestamp";

const decode = Schema.decodeSync(isoTimestampToDate);
const decodeExit = Schema.decodeExit(isoTimestampToDate);
const encodeExit = Schema.encodeExit(isoTimestampToDate);

describe("isoTimestampToDate", () => {
  it("decodes an ISO string to the instant it names", () => {
    const decoded = decode("2026-03-01T10:00:00.000Z");

    expect(decoded).toBeInstanceOf(Date);
    expect(decoded.getTime()).toBe(Date.UTC(2026, 2, 1, 10, 0, 0));
  });

  it("round-trips a Date through its wire form and back", () => {
    const original = new Date("2026-03-01T10:00:00.000Z");
    const encoded = encodeIsoTimestamp(original);

    expect(encoded).toBe("2026-03-01T10:00:00.000Z");
    expect(decode(encoded).getTime()).toBe(original.getTime());
  });

  it("round-trips an offset string to the same instant, in UTC", () => {
    // An offset names an instant unambiguously, so it decodes; encoding always
    // writes UTC, so the string that comes back is not the one that went in.
    const decoded = decode("2026-03-01T11:00:00+01:00");

    expect(encodeIsoTimestamp(decoded)).toBe("2026-03-01T10:00:00.000Z");
  });

  it.each([
    ["a string with no zone", "2026-03-01T10:00:00"],
    ["a bare calendar date", "2026-03-01"],
    ["a space in place of the T separator", "2026-03-01 10:00:00Z"],
    ["a day that does not exist", "2026-02-30T10:00:00.000Z"],
    ["free text", "next tuesday"],
    ["an empty string", ""],
  ])("refuses to decode %s", (_label, input) => {
    expect(decodeIsoTimestamp(input)).toBeNull();
    expect(Exit.isFailure(decodeExit(input))).toBe(true);
  });

  // The century rules the pattern transcribes: a year divisible by 4 is a leap
  // year, except a century year, unless that century divides by 400. The
  // pattern is a fork of Zod's with nothing upstream to check it against, so
  // these four cases are what specifies it.
  it.each([
    ["a leap day in a year divisible by four", "2024-02-29T10:00:00Z", true],
    ["February 29 in a common year", "2025-02-29T10:00:00Z", false],
    ["a leap day in a century divisible by 400", "2000-02-29T10:00:00Z", true],
    ["February 29 in a century that is not", "1900-02-29T10:00:00Z", false],
  ])("decides %s", (_label, input, isTimestamp) => {
    expect(decodeIsoTimestamp(input) !== null).toBe(isTimestamp);
    expect(Exit.isFailure(decodeExit(input))).toBe(!isTimestamp);
  });

  it("tolerates surrounding whitespace when decoding", () => {
    expect(decodeIsoTimestamp("  2026-03-01T10:00:00.000Z  ")).toEqual(
      new Date("2026-03-01T10:00:00.000Z")
    );
  });

  it("trims in the throwing form exactly as the answering one does", () => {
    // Two answers to "is this a timestamp" would be one too many, so the
    // padded string either decodes in both forms or in neither.
    const padded = "  2026-03-01T10:00:00.000Z  ";

    expect(decodeIsoTimestampOrThrow(padded)).toEqual(
      new Date("2026-03-01T10:00:00.000Z")
    );
    expect(decodeIsoTimestampOrThrow(padded)).toEqual(
      decodeIsoTimestamp(padded)
    );
    expect(() => decodeIsoTimestampOrThrow("  next tuesday  ")).toThrow();
  });

  it("refuses to encode a Date built from unparseable text", () => {
    // The case the hand-rolled `.toISOString()` could not catch: it throws a
    // RangeError at best, and elsewhere yields the literal text "Invalid Date".
    expect(() => encodeIsoTimestamp(new Date("not a date"))).toThrow();
    expect(Exit.isFailure(encodeExit(new Date(Number.NaN)))).toBe(true);
  });
});

describe("the two field spellings", () => {
  const struct = Schema.Struct({
    startsAt: dateField("When it starts"),
    occurredAt: timestampField("When it happened"),
  });

  it("is read as a timestamp through the optional rendering", () => {
    // `Schema.optional` renders as `anyOf: [T, null]`, so the keyword sits on a
    // member rather than on the property. Deriving from the schema itself is the
    // point: a hand-written document would keep passing if Effect moved where it
    // puts the keyword.
    expect(
      requireOutputFieldsFromSchema(
        "Probe",
        Schema.Struct({
          startsAt: Schema.optional(dateField("When it starts")),
        })
      )
    ).toEqual([
      {
        path: "startsAt",
        description: "When it starts",
        type: "timestamp",
        format: "timestamp",
        nullable: true,
      },
    ]);
  });

  it("gives a handler a Date for one and a string for the other", () => {
    const decoded = Schema.decodeUnknownSync(struct)({
      startsAt: "2026-03-01T10:00:00Z",
      occurredAt: "2026-03-01T10:00:00Z",
    });

    expect(decoded.startsAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(decoded.occurredAt).toBe("2026-03-01T10:00:00Z");
  });

  it("writes both back out as ISO strings", () => {
    // The wire form is what a step result, a JSONB column, and a template all
    // hold, so a `Date` in a handler leaves as text again.
    expect(
      Schema.encodeUnknownSync(struct)({
        startsAt: new Date("2026-03-01T10:00:00Z"),
        occurredAt: "2026-03-01T10:00:00Z",
      })
    ).toEqual({
      startsAt: "2026-03-01T10:00:00.000Z",
      occurredAt: "2026-03-01T10:00:00Z",
    });
  });

  it("holds both to the same contract as every other timestamp here", () => {
    // The description is a parameter because the annotations sit on the base
    // type: put on the checked schema they would land on the check, and the
    // check is what turns this text away.
    expect(() =>
      Schema.decodeUnknownSync(struct)({
        startsAt: "tomorrow",
        occurredAt: "2026-03-01T10:00:00Z",
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(struct)({
        startsAt: "2026-03-01T10:00:00Z",
        occurredAt: "2026-02-30T10:00:00Z",
      })
    ).toThrow();
  });
});
