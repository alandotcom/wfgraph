import { describe, expect, it } from "vitest";
import {
  resolveEdgeLabel,
  workflowEdgeAriaLabel,
} from "#src/components/flow-elements/edge-label";
import { COMPARISON_EDGE_ANNOTATION } from "#src/lib/workflow-graph-types";

describe("resolveEdgeLabel", () => {
  it("reads True/False from a condition branch handle", () => {
    expect(resolveEdgeLabel("true", undefined)).toBe("True");
    expect(resolveEdgeLabel("false", undefined)).toBe("False");
  });

  it("falls back to displayLabel when the handle is not a branch", () => {
    expect(
      resolveEdgeLabel(undefined, { displayLabel: "No Cancel Event" })
    ).toBe("No Cancel Event");
  });

  it("answers null when nothing labels the edge", () => {
    expect(resolveEdgeLabel(undefined, undefined)).toBeNull();
    expect(resolveEdgeLabel("other", undefined)).toBeNull();
  });
});

describe("workflowEdgeAriaLabel", () => {
  it("names both steps and the outlet when one is visible", () => {
    expect(
      workflowEdgeAriaLabel({
        sourceLabel: "Condition",
        targetLabel: "Send message",
        sourceHandleId: "false",
        data: undefined,
      })
    ).toBe("Condition to Send message, False branch");
  });

  it("adds comparison wording to an edge's accessible name", () => {
    expect(
      workflowEdgeAriaLabel({
        sourceLabel: "Condition",
        targetLabel: "Archive lead",
        sourceHandleId: null,
        data: {
          [COMPARISON_EDGE_ANNOTATION]: {
            kind: "removed",
            sourceId: "edge_1",
          },
        },
      })
    ).toBe("Condition to Archive lead, Removed in comparison");
  });
});
