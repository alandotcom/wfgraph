import { describe, expect, it } from "vitest";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { completedDocument, input } from "#src/agent/judges/semantics/fixtures";

/** The fixture graph with a "Lookups" Group holding the score step and a lookup step. */
function groupedDocument(): AgentEvalDocument {
  const document = completedDocument();
  return {
    nodes: [
      ...document.nodes.map((node) =>
        node.id === "score" ? { ...node, parentId: "lookups" } : node
      ),
      {
        id: "lookups",
        type: "group",
        position: { x: 0, y: 0 },
        data: { label: "Lookups", type: "group", config: {} },
      },
      {
        id: "profile",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Get applicant profile",
          type: "action",
          config: { actionType: "crm/get-applicant" },
        },
        parentId: "lookups",
      },
    ],
    edges: [
      ...document.edges,
      { id: "score-profile", source: "score", target: "profile" },
    ],
  };
}

const groupInput: AgentEvalInput = {
  ...input,
  expected: {
    ...input.expected,
    exactActions: { "score-applicant": 1, "crm/get-applicant": 1 },
  },
};

function withGroupExpectations(
  expected: Partial<AgentEvalInput["expected"]>
): AgentEvalInput {
  return { ...groupInput, expected: { ...groupInput.expected, ...expected } };
}

describe("assessScenarioSemantics Group rules", () => {
  it("accepts a Group holding every selected member and the expected count", () => {
    expect(
      assessScenarioSemantics(
        withGroupExpectations({
          requiredGroups: [
            {
              label: "Lookups",
              members: [
                { kind: "action", actionId: "score-applicant" },
                { kind: "action", actionId: "crm/get-applicant" },
              ],
              memberCount: 2,
            },
          ],
          exactGroupCount: 1,
        }),
        groupedDocument()
      )
    ).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("names a missing Group, a missing member, and a wrong member count", () => {
    const document = groupedDocument();
    const ungroupedProfile = {
      ...document,
      nodes: document.nodes.map((node) =>
        node.id === "profile" ? { ...node, parentId: undefined } : node
      ),
    };
    expect(
      assessScenarioSemantics(
        withGroupExpectations({
          requiredGroups: [
            { label: "Follow-up", members: [] },
            {
              label: "Lookups",
              members: [{ kind: "action", actionId: "crm/get-applicant" }],
            },
          ],
        }),
        ungroupedProfile
      ).rationale
    ).toBe(
      "missing Group Follow-up; Group Lookups does not contain crm/get-applicant."
    );
    expect(
      assessScenarioSemantics(
        withGroupExpectations({
          requiredGroups: [{ label: "Lookups", members: [], memberCount: 3 }],
        }),
        document
      ).rationale
    ).toBe("Group Lookups holds 2 steps, expected 3.");
  });

  it("reports a forbidden Group label and a wrong Group count", () => {
    expect(
      assessScenarioSemantics(
        withGroupExpectations({
          forbiddenGroups: ["Lookups"],
          exactGroupCount: 0,
        }),
        groupedDocument()
      ).rationale
    ).toBe(
      "Group Lookups is still present; Expected exactly 0 Groups, found 1."
    );
  });
});
