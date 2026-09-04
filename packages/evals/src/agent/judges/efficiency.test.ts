import { describe, expect, it } from "vitest";
import { assessEfficiencyBudget } from "#src/agent/judges/efficiency";

describe("assessEfficiencyBudget", () => {
  it("accepts trace usage within every declared limit", () => {
    expect(
      assessEfficiencyBudget({
        budget: {
          maxModelCalls: 2,
          maxToolCalls: 5,
          maxGraphRevisions: 2,
          maxRefusals: 1,
        },
        traceSummary: {
          modelCalls: 2,
          toolCalls: 5,
          graphRevisions: 2,
          refusals: 1,
        },
      })
    ).toEqual({
      score: 1,
      rationale: "The trace usage stays within the advisory efficiency budget.",
    });
  });

  it("reports every exceeded advisory limit", () => {
    expect(
      assessEfficiencyBudget({
        budget: {
          maxModelCalls: 1,
          maxToolCalls: 2,
          maxGraphRevisions: 3,
          maxRefusals: 0,
        },
        traceSummary: {
          modelCalls: 2,
          toolCalls: 4,
          graphRevisions: 4,
          refusals: 1,
        },
      })
    ).toEqual({
      score: 0,
      rationale:
        "model calls 2 exceed the limit of 1; tool calls 4 exceed the limit of 2; graph revisions 4 exceed the limit of 3; refusals 1 exceed the limit of 0.",
    });
  });
});
