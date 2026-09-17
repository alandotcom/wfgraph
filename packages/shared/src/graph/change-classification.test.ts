import { describe, expect, it } from "vitest";
import {
  classifyWorkflowComparison,
  fieldChangeCategory,
  isGroupFrameChange,
  nodeChangeCategories,
} from "#src/graph/change-classification";
import { createSerializedWorkflowGraph } from "#src/graph/graph";
import type { WorkflowNode } from "#src/graph/types";

function step(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action" },
  };
}

function member(id: string, parentId: string): WorkflowNode {
  return { ...step(id), parentId };
}

function frame(id: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: id, type: "group" },
  };
}

describe("fieldChangeCategory", () => {
  it("puts every field of a Group frame and a step's membership in Organization", () => {
    expect(
      fieldChangeCategory({ path: ["data", "label"], groupFrame: true })
    ).toBe("organization");
    expect(
      fieldChangeCategory({
        path: ["data", "config", "direction"],
        groupFrame: true,
      })
    ).toBe("organization");
    expect(fieldChangeCategory({ path: ["parentId"], groupFrame: false })).toBe(
      "organization"
    );
  });

  it("puts a step's configuration, enabled state, and label in Behavior", () => {
    for (const path of [
      ["data", "config", "actionType"],
      ["data", "enabled"],
      ["data", "label"],
    ]) {
      expect(fieldChangeCategory({ path, groupFrame: false })).toBe("behavior");
    }
  });
});

describe("isGroupFrameChange", () => {
  it("is true only when every side holding the node holds a Group frame", () => {
    expect(isGroupFrameChange({ before: "group", after: undefined })).toBe(
      true
    );
    expect(isGroupFrameChange({ before: "group", after: "action" })).toBe(
      false
    );
    expect(isGroupFrameChange({ before: undefined, after: undefined })).toBe(
      false
    );
  });
});

describe("nodeChangeCategories", () => {
  it("counts an added or removed step as Behavior even when it sits in a Group", () => {
    expect(
      nodeChangeCategories({
        change: {
          nodeId: "a",
          kind: "added",
          fields: [{ path: ["parentId"], kind: "added", after: "group" }],
        },
        groupFrame: false,
      })
    ).toEqual({ organization: false, behavior: true });
  });

  it("counts a modified step that records no field as Behavior", () => {
    expect(
      nodeChangeCategories({
        change: { nodeId: "a", kind: "modified", fields: [] },
        groupFrame: false,
      })
    ).toEqual({ organization: false, behavior: true });
  });

  it("reports both categories for a step whose membership and settings changed", () => {
    expect(
      nodeChangeCategories({
        change: {
          nodeId: "a",
          kind: "modified",
          fields: [
            { path: ["data", "enabled"], kind: "added", after: false },
            { path: ["parentId"], kind: "removed", before: "group" },
          ],
        },
        groupFrame: false,
      })
    ).toEqual({ organization: true, behavior: true });
  });
});

describe("classifyWorkflowComparison", () => {
  it("reads Group frames from either graph and counts any edge change as Behavior", () => {
    const payload = {
      baseGraph: createSerializedWorkflowGraph({
        nodes: [frame("old"), member("a", "old")],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [step("a")],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "a",
          kind: "modified" as const,
          fields: [
            { path: ["parentId"], kind: "removed" as const, before: "old" },
          ],
        },
        { nodeId: "old", kind: "removed" as const, fields: [] },
      ],
      edgeChanges: [],
    };

    const categories = classifyWorkflowComparison(payload);
    expect([...categories.groupFrameIds]).toEqual(["old"]);
    expect(categories).toMatchObject({ organization: true, behavior: false });
    expect(classifyWorkflowComparison(payload)).toBe(categories);

    expect(
      classifyWorkflowComparison({
        ...payload,
        edgeChanges: [{ edgeId: "x", kind: "added" }],
      })
    ).toMatchObject({ organization: true, behavior: true });
  });
});
