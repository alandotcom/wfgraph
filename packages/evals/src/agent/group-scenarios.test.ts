/**
 * Each Group scenario is solvable, and its expectations agree with each other.
 *
 * A reference is the graph the scenario asks for, built by hand. Holding it to
 * the document-only judges and to draft and publish validation proves that the
 * task can be met and that a ready reference keeps its Group within the v1
 * Publish rules. The trajectory judges score how a model worked, so a hand-built
 * graph is not held to them.
 */

import { describe, expect, it } from "vitest";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import { groupScenarios, screeningDocument } from "#src/agent/group-scenarios";
import { assessGraphGrounding } from "#src/agent/judges/graph";
import { assessResolvableReferences } from "#src/agent/judges/resolvable-references";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import {
  evalCatalog,
  connectedIntegrations,
} from "#src/agent/scenario-fixtures";

function groupScenario(name: string) {
  const found = groupScenarios.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`The Group scenario "${name}" is missing`);
  }
  return found;
}

describe("screeningDocument", () => {
  it("is a draft that saves and publishes with its Group", () => {
    expect(
      validateAgentDraft({
        document: screeningDocument,
        catalog: evalCatalog,
        integrations: connectedIntegrations,
      })
    ).toMatchObject({ draftValid: true, publishBlockers: [] });
  });
});

describe.each(groupScenarios)(
  "reference solution for $name",
  ({ input, reference }) => {
    it("satisfies every scenario expectation", () => {
      const assessment = assessScenarioSemantics(input, reference);
      expect(assessment.score, assessment.rationale).toBe(1);
    });

    it("names only actions and connections the catalog holds", () => {
      const assessment = assessGraphGrounding({
        document: reference,
        catalog: input.catalog,
        integrations: input.integrations,
      });
      expect(assessment.score, assessment.rationale).toBe(1);
    });

    it("reads only paths its own steps can address", () => {
      const assessment = assessResolvableReferences({
        document: reference,
        catalog: input.catalog,
      });
      expect(assessment.score, assessment.rationale).toBe(1);
    });

    it("saves as a draft with no publish blocker", () => {
      expect(
        validateAgentDraft({
          document: reference,
          catalog: input.catalog,
          integrations: input.integrations,
        })
      ).toMatchObject({ draftValid: true, publishBlockers: [] });
    });
  }
);

describe("Group scenario expectations", () => {
  it("reject the starting graph for a turn that must dissolve the Group", () => {
    const { input } = groupScenario(
      "dissolves a Group left with one step and names it"
    );
    const assessment = assessScenarioSemantics(input, screeningDocument);
    expect(assessment.score).toBe(0);
    expect(assessment.rationale).toContain("Group Screening is still present");
  });

  it("reject an inserted step left outside the Group, which Publish also refuses", () => {
    const { input, reference } = groupScenario(
      "inserts a step between two Group members inside the Group"
    );
    const outsideGroup = {
      ...reference,
      nodes: reference.nodes.map((node) =>
        node.id === "log" ? { ...node, parentId: undefined } : node
      ),
    };

    expect(assessScenarioSemantics(input, outsideGroup)).toEqual({
      score: 0,
      rationale: "Group Screening holds 2 steps, expected 3.",
    });
    expect(
      validateAgentDraft({
        document: outsideGroup,
        catalog: input.catalog,
        integrations: input.integrations,
      }).publishBlockers.map((blocker) => blocker.kind)
    ).toContain("invalid_group");
  });
});
