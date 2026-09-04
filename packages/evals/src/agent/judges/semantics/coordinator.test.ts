import { describe, expect, it } from "vitest";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { completedDocument, input } from "#src/agent/judges/semantics/fixtures";

describe("assessScenarioSemantics", () => {
  it("accepts a graph that satisfies the scenario constraints", () => {
    expect(assessScenarioSemantics(input, completedDocument())).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("reports missing actions, Events, and flows together", () => {
    expect(assessScenarioSemantics(input, { nodes: [], edges: [] })).toEqual({
      score: 0,
      rationale:
        "Expected exactly 1 score-applicant node, found 0; Start Events must be exactly applicant.created, found none; missing required flow lifecycle -> score-applicant through started.",
    });
  });
});
