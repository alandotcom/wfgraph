import { describe, expect, it } from "vitest";
import {
  addedIngressSourceRefusal,
  addedJoinRuleRefusal,
  groupContractViolations,
  groupStepCount,
  joinRuleBreakKeys,
} from "#src/graph/group-contract";
import { fanOutStoreEdges } from "#src/graph/node-group";
import { omitUndefined } from "#src/utils/omit-undefined";
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

describe("addedIngressSourceRefusal", () => {
  const step = (id: string, parentId?: string): WorkflowNode =>
    omitUndefined({
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: id,
        type: "action",
        config: { actionType: "test/read" },
      },
      parentId,
    });
  const frame = (id: string): WorkflowNode => ({
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: id.toUpperCase(), type: "group", config: {} },
  });
  // Group A ends at two members and Group B starts at two, with nothing
  // connecting them yet.
  const nodes = [
    step("x"),
    frame("a"),
    step("a1", "a"),
    step("a2", "a"),
    frame("b"),
    step("b1", "b"),
    step("b2", "b"),
  ];

  it("allows fan-out from the one source port a Group is entered from", () => {
    const edges = [{ id: "x-b1", source: "x", target: "b1" }];
    const additions = fanOutStoreEdges({
      nodes,
      edges,
      sourceId: "x",
      targetId: "b2",
      sourceHandle: undefined,
    });

    expect(additions).toEqual([
      { source: "x", target: "b2", sourceHandle: undefined },
    ]);
    expect(addedIngressSourceRefusal({ nodes, edges, additions })).toBeNull();
  });

  it("refuses a Cartesian product of a Group's continuing ports and Group entries", () => {
    const edges = [
      { id: "a1-x", source: "a1", target: "x" },
      { id: "a2-x", source: "a2", target: "x" },
    ];
    const additions = fanOutStoreEdges({
      nodes,
      edges,
      sourceId: "a",
      targetId: "b",
      sourceHandle: undefined,
    });

    expect(additions).toHaveLength(4);
    expect(addedIngressSourceRefusal({ nodes, edges, additions })).toBe(
      'This connection would enter the Group "B" from 2 outlets. A Group is entered from one outlet.'
    );
  });

  it("leaves a Group already entered from two ports to Publish", () => {
    const edges = [
      { id: "x-b1", source: "x", target: "b1" },
      { id: "a1-b1", source: "a1", target: "b1" },
    ];
    const additions = [{ source: "x", target: "b2" }];

    expect(addedIngressSourceRefusal({ nodes, edges, additions })).toBeNull();
    expect(
      groupContractViolations({ nodes, edges }).map((item) => item.rule)
    ).toContain("multiple_ingress_sources");
  });
});

describe("addedJoinRuleRefusal", () => {
  const step = (
    id: string,
    parentId?: string,
    actionType = "test/read"
  ): WorkflowNode =>
    omitUndefined({
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: { label: id, type: "action", config: { actionType } },
      parentId,
    });
  const frame: WorkflowNode = {
    id: "g",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Lookups", type: "group", config: {} },
  };
  const link = (source: string, target: string, sourceHandle?: string) =>
    omitUndefined({ source, target, sourceHandle });

  it("allows the second branch of an unconditional internal fan-out into its join", () => {
    const nodes = [
      step("s"),
      frame,
      ...["a", "b", "c", "j"].map((id) => step(id, "g")),
    ];
    const edges = [
      link("s", "a"),
      link("a", "b"),
      link("a", "c"),
      link("b", "j"),
    ];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("c", "j")] })
    ).toBeNull();
  });

  it("refuses an edge from the outside port onto a member that already joins inside", () => {
    const nodes = [step("s"), frame, step("a", "g"), step("j", "g")];
    const edges = [link("s", "a"), link("a", "j")];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("s", "j")] })
    ).toBe(
      'Group "Lookups" holds the join at "j", and a branch into it starts outside the Group. Put every branch into the join inside the Group.'
    );
  });

  it("refuses the edge that puts a Condition on a join arm when its other branch ends inside the Group", () => {
    const nodes = [
      step("s"),
      frame,
      step("a", "g"),
      step("c", "g", "Condition"),
      step("b", "g"),
      step("d", "g"),
      step("e", "g"),
      step("j", "g"),
    ];
    const edges = [
      link("s", "a"),
      link("a", "c"),
      link("c", "b", "true"),
      link("c", "d", "false"),
      link("a", "e"),
      link("e", "j"),
    ];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("b", "j")] })
    ).toBe(
      'Group "Lookups" has "c" on a branch into the join at "j", and the Condition can end that branch before the join runs.'
    );
  });

  it("leaves a join rule the Group already breaks to Publish", () => {
    const nodes = [
      step("s"),
      frame,
      step("a", "g"),
      step("j", "g"),
      step("k", "g"),
    ];
    const edges = [link("s", "a"), link("s", "j"), link("a", "j")];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("j", "k")] })
    ).toBeNull();
    expect(
      groupContractViolations({ nodes, edges }).map((item) => item.rule)
    ).toContain("join_crosses_boundary");
  });

  it("refuses a second join that breaks the rule with the same labels as a join that already breaks it", () => {
    const labelled = (node: WorkflowNode, label: string): WorkflowNode => ({
      ...node,
      data: { ...node.data, label },
    });
    const nodes = [
      step("s"),
      frame,
      step("a", "g"),
      step("c", "g", "Condition"),
      step("b", "g"),
      step("e", "g"),
      labelled(step("j1", "g"), "Join"),
      step("f", "g"),
      step("h", "g"),
      labelled(step("j2", "g"), "Join"),
    ];
    // `c` already lies on an arm of `j1`, and `h` -> `j2` puts it on an arm of
    // `j2`, whose message reads the same as `j1`'s.
    const edges = [
      link("s", "a"),
      link("a", "c"),
      link("c", "b", "true"),
      link("a", "e"),
      link("b", "j1"),
      link("e", "j1"),
      link("c", "h", "true"),
      link("a", "f"),
      link("f", "j2"),
    ];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("h", "j2")] })
    ).toBe(
      'Group "Lookups" has "c" on a branch into the join at "Join", and the Condition can end that branch before the join runs.'
    );
  });

  it("leaves a join that already names a Condition on its arms to Publish when a new arm reorders its arms", () => {
    const nodes = [
      step("s"),
      frame,
      step("a", "g"),
      step("c1", "g", "Condition"),
      step("c2", "g", "Condition"),
      step("p1", "g"),
      step("p2", "g"),
      step("q", "g"),
      step("j", "g"),
    ];
    // Walking up from `j` meets `c2` before `c1`, and the edge `q` -> `j`
    // makes the walk meet `c1` first.
    const edges = [
      link("s", "a"),
      link("a", "c1"),
      link("a", "c2"),
      link("c1", "p1", "true"),
      link("c2", "p2", "true"),
      link("c1", "q", "true"),
      link("p1", "j"),
      link("p2", "j"),
    ];

    expect(
      addedJoinRuleRefusal({ nodes, edges, additions: [link("q", "j")] })
    ).toBeNull();
  });

  it("computes the current join breaks once across repeated refusals for the same stored edges", () => {
    const nodes = [step("s"), frame, step("a", "g"), step("j", "g")];
    const edges = [link("s", "a"), link("s", "j"), link("a", "j")];
    const current = joinRuleBreakKeys({ nodes, edges });

    for (const target of ["a", "j"]) {
      addedJoinRuleRefusal({ nodes, edges, additions: [link("s", target)] });
    }

    expect(joinRuleBreakKeys({ nodes, edges })).toBe(current);
    expect(current.size).toBe(1);
    expect(joinRuleBreakKeys({ nodes, edges: [...edges] })).not.toBe(current);
  });
});
