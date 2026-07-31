/**
 * What the run-log scrubber answers.
 *
 * Its result goes straight into a JSONB column, so the two things under test are
 * that a secret is masked and that what comes back is JSON: a value the format
 * has no spelling for must not reach the driver, which stringifies whatever it
 * is handed.
 */

import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";

describe("redactSensitiveData", () => {
  it("masks a secret by its key and leaves the rest alone", () => {
    expect(
      redactSensitiveData({ to: "+15550100", apiKey: "sk_live_abcd1234" })
    ).toEqual({ to: "+15550100", apiKey: "********1234" });
  });

  it("masks a non-string secret whole, having no tail to show", () => {
    expect(redactSensitiveData({ token: { value: "x" } })).toEqual({
      token: "[REDACTED]",
    });
  });

  it("drops a key holding nothing, as serializing would", () => {
    expect(redactSensitiveData({ eventName: undefined, id: "1" })).toEqual({
      id: "1",
    });
  });

  it("drops a sensitive key holding nothing rather than masking it", () => {
    expect(redactSensitiveData({ token: undefined, id: "1" })).toEqual({
      id: "1",
    });
  });

  it("leaves a sensitive key holding null as null, not a masked secret", () => {
    expect(redactSensitiveData({ apiKey: null, id: "1" })).toEqual({
      apiKey: null,
      id: "1",
    });
  });

  it("drops a key JSON cannot spell", () => {
    expect(redactSensitiveData({ render: () => "x", id: "1" })).toEqual({
      id: "1",
    });
  });

  it("answers null for such a value inside a list, where a key cannot go", () => {
    expect(redactSensitiveData([1, () => "x"])).toEqual([1, null]);
  });

  it("passes a bare JSON value through", () => {
    expect(redactSensitiveData("plain")).toBe("plain");
    expect(redactSensitiveData(null)).toBeNull();
    expect(redactSensitiveData(undefined)).toBeUndefined();
  });
});
