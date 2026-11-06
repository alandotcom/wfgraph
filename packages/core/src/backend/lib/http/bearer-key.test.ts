import { describe, expect, it } from "vitest";
import { bearerKeyMatches } from "#src/backend/lib/http/bearer-key";

const KEY = "events-key-0123456789";

describe("bearerKeyMatches", () => {
  it("accepts the key under the Bearer scheme, in any case", () => {
    expect(bearerKeyMatches(`Bearer ${KEY}`, KEY)).toBe(true);
    expect(bearerKeyMatches(`bearer ${KEY}`, KEY)).toBe(true);
  });

  // `timingSafeEqual` throws on buffers of different lengths. Comparing the
  // digests is what lets a key of any length reach the constant-time compare.
  it.each(["", "a", KEY.slice(0, -1), `${KEY}x`, "x".repeat(KEY.length)])(
    "refuses the key %j without throwing",
    (presented) => {
      expect(bearerKeyMatches(`Bearer ${presented}`, KEY)).toBe(false);
    }
  );

  it("refuses a missing header and another scheme", () => {
    expect(bearerKeyMatches(undefined, KEY)).toBe(false);
    expect(bearerKeyMatches(KEY, KEY)).toBe(false);
    expect(bearerKeyMatches(`Basic ${KEY}`, KEY)).toBe(false);
    expect(bearerKeyMatches(`Bearer ${KEY} extra`, KEY)).toBe(false);
  });
});
