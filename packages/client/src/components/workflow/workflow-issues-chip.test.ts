import { describe, expect, it } from "vitest";
import { workflowIssuesLabel } from "#src/components/workflow/workflow-issues-chip";

describe("workflowIssuesLabel", () => {
  it("agrees with its own count in both grammatical numbers", () => {
    // The chip is the only thing on screen saying publish will be refused, so
    // the count and the noun have to describe the same list.
    expect(workflowIssuesLabel(1)).toBe("1 issue");
    expect(workflowIssuesLabel(2)).toBe("2 issues");
  });

  it("grows by exactly one character crossing into double figures", () => {
    // The strip is a fixed-height row with no wrapping, so 9 to 10 has to be a
    // one-character change rather than a longer phrase.
    expect(workflowIssuesLabel(10).length - workflowIssuesLabel(9).length).toBe(
      1
    );
  });
});
