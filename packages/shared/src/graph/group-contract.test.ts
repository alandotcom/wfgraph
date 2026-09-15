import { describe, expect, it } from "vitest";
import {
  groupContractViolations,
  groupStepCount,
} from "#src/graph/group-contract";
import { groupContractMatrix } from "#src/graph/group-contract-test-support";
import { groupStructureRefusalReason } from "#src/graph/group-structure";
import type { WorkflowNode } from "#src/graph/types";
import { workflowTopologyRefusalReason } from "#src/graph/workflow-topology";

describe("groupContractViolations boundary matrix", () => {
  it.each(groupContractMatrix)("$name", (matrixCase) => {
    const violations = groupContractViolations(matrixCase);

    expect(violations.map((violation) => violation.rule)).toEqual(
      matrixCase.rules
    );
    for (const violation of violations) {
      expect(violation).toMatchObject({ groupId: "g", groupLabel: "Lookups" });
      expect(violation.message).toContain('Group "Lookups"');
    }
  });

  // Publication is the gate for these rules. The draft save refuses only what
  // its own topology check already refused before the Group rules existed.
  it.each(groupContractMatrix)("$name saves as a draft", (matrixCase) => {
    expect(workflowTopologyRefusalReason(matrixCase) === null).toBe(
      matrixCase.savesAsDraft
    );
  });
});

describe("groupContractViolations", () => {
  const frame = (id: string, label: string): WorkflowNode => ({
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label, type: "group", config: {} },
  });

  it("answers an empty list for a graph with no Group", () => {
    const [{ nodes, edges }] = groupContractMatrix;
    expect(
      groupContractViolations({
        nodes: nodes
          .filter((node) => node.data.type !== "group")
          .map((node) => ({ ...node, parentId: undefined })),
        edges,
      })
    ).toEqual([]);
  });

  it("refuses a Group frame with no members", () => {
    expect(
      groupContractViolations({ nodes: [frame("empty", "Empty")], edges: [] })
    ).toEqual([
      {
        groupId: "empty",
        groupLabel: "Empty",
        rule: "too_few_members",
        message: 'Group "Empty" needs at least two steps',
      },
    ]);
  });

  // The draft save refuses a nested Group, so the Group rules only count it out
  // of the Group's steps.
  it("leaves a nested Group to the draft save", () => {
    const nested = { ...frame("inner", "Inner"), parentId: "outer" };
    const graph = { nodes: [frame("outer", "Outer"), nested], edges: [] };

    expect(groupStructureRefusalReason(graph)).toContain(
      'Group "Inner" cannot sit inside another Group'
    );
    expect(
      groupContractViolations(graph).map((violation) => violation.rule)
    ).toEqual(["too_few_members", "too_few_members"]);
  });

  it("quotes no config value in any message", () => {
    const secret = "sk_live_do_not_print";
    const withSecrets = groupContractMatrix.map((matrixCase) => ({
      ...matrixCase,
      nodes: matrixCase.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          config: { ...node.data.config, apiKey: secret },
        },
      })),
    }));

    for (const matrixCase of withSecrets) {
      for (const violation of groupContractViolations(matrixCase)) {
        expect(violation.message).not.toContain(secret);
      }
    }
  });
});

describe("groupStepCount", () => {
  it("counts action members and leaves out an Event Split", () => {
    const eventSplitMember = groupContractMatrix.find(
      (matrixCase) => matrixCase.name === "Event Split member"
    );
    if (!eventSplitMember) {
      throw new Error("matrix case missing");
    }

    expect(
      groupStepCount({ groupId: "g", nodes: eventSplitMember.nodes })
    ).toBe(1);
  });
});
