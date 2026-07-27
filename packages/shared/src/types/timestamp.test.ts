import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  decodeIsoTimestamp,
  encodeIsoTimestamp,
  isoTimestampToDate,
} from "@/types/timestamp";

describe("isoTimestampToDate", () => {
  it("decodes an ISO string to the instant it names", () => {
    const decoded = z.decode(isoTimestampToDate, "2026-03-01T10:00:00.000Z");

    expect(decoded).toBeInstanceOf(Date);
    expect(decoded.getTime()).toBe(Date.UTC(2026, 2, 1, 10, 0, 0));
  });

  it("round-trips a Date through its wire form and back", () => {
    const original = new Date("2026-03-01T10:00:00.000Z");
    const encoded = encodeIsoTimestamp(original);

    expect(encoded).toBe("2026-03-01T10:00:00.000Z");
    expect(z.decode(isoTimestampToDate, encoded).getTime()).toBe(
      original.getTime()
    );
  });

  it("round-trips an offset string to the same instant, in UTC", () => {
    // An offset names an instant unambiguously, so it decodes; encoding always
    // writes UTC, so the string that comes back is not the one that went in.
    const decoded = z.decode(isoTimestampToDate, "2026-03-01T11:00:00+01:00");

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
    expect(z.safeDecode(isoTimestampToDate, input).success).toBe(false);
  });

  it("tolerates surrounding whitespace when decoding", () => {
    expect(decodeIsoTimestamp("  2026-03-01T10:00:00.000Z  ")).toEqual(
      new Date("2026-03-01T10:00:00.000Z")
    );
  });

  it("refuses to encode a Date built from unparseable text", () => {
    // The case the hand-rolled `.toISOString()` could not catch: it throws a
    // RangeError at best, and elsewhere yields the literal text "Invalid Date".
    expect(() => encodeIsoTimestamp(new Date("not a date"))).toThrow();
    expect(z.safeEncode(isoTimestampToDate, new Date(Number.NaN)).success).toBe(
      false
    );
  });
});
