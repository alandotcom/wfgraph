import { describe, expect, it } from "vitest";
import { parseIntentVerdict } from "#src/agent/judges/intent";

describe("parseIntentVerdict", () => {
  it("reads a structured verdict from a fenced response", () => {
    expect(
      parseIntentVerdict(
        '```json\n{"verdict":"pass","rationale":"The branches match.","evidence":["High scores reach Linear."]}\n```'
      )
    ).toEqual({
      verdict: "pass",
      rationale: "The branches match.",
      evidence: ["High scores reach Linear."],
    });
  });

  it("returns a diagnostic failure for malformed output", () => {
    expect(parseIntentVerdict("looks fine")).toEqual({
      verdict: "fail",
      rationale: "The intent judge returned malformed output.",
      evidence: [],
    });
  });
});
