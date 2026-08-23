import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  keepIntentJudgeAdvisory,
  parseIntentVerdict,
} from "#src/agent/judges/intent";

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

  it("accepts the structured object returned by the judge harness", () => {
    expect(
      parseIntentVerdict({
        verdict: "pass",
        rationale: "The branches match.",
        evidence: ["High scores reach Linear."],
      })
    ).toEqual({
      verdict: "pass",
      rationale: "The branches match.",
      evidence: ["High scores reach Linear."],
    });
  });

  it("returns an advisory diagnostic for malformed output", () => {
    expect(parseIntentVerdict("looks fine")).toEqual({
      verdict: "na",
      rationale: "The intent judge returned malformed output.",
      evidence: [],
    });
  });
});

describe("keepIntentJudgeAdvisory", () => {
  it("turns a provider failure into an advisory verdict", async () => {
    const verdict = await Effect.runPromise(
      keepIntentJudgeAdvisory(Effect.fail("provider unavailable"))
    );

    expect(verdict).toEqual({
      verdict: "na",
      rationale: "The intent judge request failed.",
      evidence: [],
    });
  });
});
