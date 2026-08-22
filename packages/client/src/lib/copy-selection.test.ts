import { describe, expect, it } from "vitest";
import {
  cloneSelection,
  extractCopyableSelection,
  isCopyableNode,
  nodeIdsForContextCopy,
  offsetToOrigin,
  PASTE_OFFSET,
} from "#src/lib/copy-selection";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";

function lifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: id, type: "lifecycle" },
  };
}

function actionNode(
  id: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
  config?: Record<string, unknown>
): WorkflowNode {
  return {
    id,
    type: "action",
    position,
    selected: true,
    data: {
      label: id,
      type: "action",
      ...(config ? { config } : {}),
    },
  };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

function sequentialIds(labels: string[]) {
  let index = 0;
  return () => {
    const id = labels[index];
    index += 1;
    if (!id) {
      throw new Error(
        "cloneSelection asked for more ids than the test provided"
      );
    }
    return id;
  };
}

describe("isCopyableNode", () => {
  it("refuses the Lifecycle Node and the homepage placeholder", () => {
    expect(isCopyableNode(lifecycleNode("t"))).toBe(false);
    expect(
      isCopyableNode({
        id: "add",
        type: "add",
        position: { x: 0, y: 0 },
        data: { label: "", type: "add" },
      })
    ).toBe(false);
    expect(isCopyableNode(actionNode("a"))).toBe(true);
  });
});

describe("extractCopyableSelection", () => {
  it("takes selected action nodes and the edges that run between them", () => {
    const nodes = [
      lifecycleNode("t"),
      actionNode("a", { x: 10, y: 20 }),
      actionNode("b", { x: 30, y: 40 }),
    ];
    const edges = [edge("e-t-a", "t", "a"), edge("e-a-b", "a", "b")];

    const copied = extractCopyableSelection({ nodes, edges });

    expect(copied?.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(copied?.edges.map((item) => item.id)).toEqual(["e-a-b"]);
  });

  it("drops an edge that leaves the selection", () => {
    const nodes = [
      lifecycleNode("t"),
      { ...actionNode("a"), selected: true },
      { ...actionNode("b"), selected: false },
    ];
    const copied = extractCopyableSelection({
      nodes,
      edges: [edge("e-a-b", "a", "b")],
    });

    expect(copied?.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(copied?.edges).toEqual([]);
  });

  it("returns nothing when only the Lifecycle Node is selected", () => {
    expect(
      extractCopyableSelection({
        nodes: [
          { ...lifecycleNode("t"), selected: true },
          { ...actionNode("a"), selected: false },
        ],
        edges: [],
      })
    ).toBeNull();
  });

  it("copies by id even when the node is not selected", () => {
    const copied = extractCopyableSelection({
      nodes: [{ ...actionNode("a"), selected: false }],
      edges: [],
      nodeIds: new Set(["a"]),
    });

    expect(copied?.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("strips run status so a paste cannot write overlay state into the draft", () => {
    const copied = extractCopyableSelection({
      nodes: [
        {
          ...actionNode("a"),
          data: { ...actionNode("a").data, status: "success" },
        },
      ],
      edges: [],
    });

    expect(copied?.nodes[0]?.data.status).toBeUndefined();
  });
});

describe("nodeIdsForContextCopy", () => {
  it("copies the whole selection when the clicked node is already selected", () => {
    const nodes = [
      { ...actionNode("a"), selected: true },
      { ...actionNode("b"), selected: true },
      { ...actionNode("c"), selected: false },
    ];

    expect([...nodeIdsForContextCopy(nodes, "a")].sort()).toEqual(["a", "b"]);
  });

  it("copies only the clicked node when it is not in the selection", () => {
    const nodes = [
      { ...actionNode("a"), selected: true },
      { ...actionNode("b"), selected: false },
    ];

    expect([...nodeIdsForContextCopy(nodes, "b")]).toEqual(["b"]);
  });

  it("copies nothing for the Lifecycle Node", () => {
    expect(
      nodeIdsForContextCopy([{ ...lifecycleNode("t"), selected: true }], "t")
        .size
    ).toBe(0);
  });
});

describe("cloneSelection", () => {
  it("assigns fresh ids, offsets positions, and remaps internal edges", () => {
    const extracted = extractCopyableSelection({
      nodes: [
        actionNode("a", { x: 10, y: 20 }),
        actionNode("b", { x: 30, y: 40 }),
      ],
      edges: [edge("e-a-b", "a", "b")],
    });
    if (!extracted) {
      throw new Error("expected a copyable selection");
    }

    const cloned = cloneSelection(extracted, {
      offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
      createId: sequentialIds(["a2", "b2", "e2"]),
    });

    expect(cloned.nodes.map((node) => node.id)).toEqual(["a2", "b2"]);
    expect(cloned.nodes.map((node) => node.position)).toEqual([
      { x: 10 + PASTE_OFFSET, y: 20 + PASTE_OFFSET },
      { x: 30 + PASTE_OFFSET, y: 40 + PASTE_OFFSET },
    ]);
    expect(cloned.edges).toEqual([
      {
        id: "e2",
        source: "a2",
        target: "b2",
        selected: true,
      },
    ]);
    expect(cloned.nodes.every((node) => node.selected)).toBe(true);
  });

  it("rewrites template tokens that name a copied node, and leaves the rest", () => {
    const tokenA = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });
    const tokenOutside = formatTemplateToken({
      nodeId: "outside",
      nodeLabel: "User",
      fieldPath: "id",
    });

    const extracted = extractCopyableSelection({
      nodes: [
        actionNode("a", { x: 0, y: 0 }),
        actionNode(
          "b",
          { x: 0, y: 0 },
          {
            body: `Hello ${tokenA} and ${tokenOutside}`,
            nested: { to: tokenA },
            list: [tokenA],
          }
        ),
      ],
      edges: [],
    });
    if (!extracted) {
      throw new Error("expected a copyable selection");
    }

    const cloned = cloneSelection(extracted, {
      offset: { x: 0, y: 0 },
      createId: sequentialIds(["a2", "b2"]),
    });

    const remappedA = formatTemplateToken({
      nodeId: "a2",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });
    expect(cloned.nodes[1]?.data.config).toEqual({
      body: `Hello ${remappedA} and ${tokenOutside}`,
      nested: { to: remappedA },
      list: [remappedA],
    });
  });

  it("rewrites tokens even when the config still holds undefined optional keys", () => {
    const tokenA = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });

    const extracted = extractCopyableSelection({
      nodes: [
        actionNode("a", { x: 0, y: 0 }),
        actionNode(
          "b",
          { x: 0, y: 0 },
          { integrationId: undefined, body: tokenA }
        ),
      ],
      edges: [],
    });
    if (!extracted) {
      throw new Error("expected a copyable selection");
    }

    const cloned = cloneSelection(extracted, {
      offset: { x: 0, y: 0 },
      createId: sequentialIds(["a2", "b2"]),
    });

    expect(cloned.nodes[1]?.data.config).toStrictEqual({
      integrationId: undefined,
      body: formatTemplateToken({
        nodeId: "a2",
        nodeLabel: "Fetch",
        fieldPath: "email",
      }),
    });
  });
});

describe("copying a Group", () => {
  function groupNode(): WorkflowNode {
    return {
      id: "g",
      type: "group",
      position: { x: 40, y: 80 },
      selected: true,
      data: {
        label: "Lookups",
        type: "group",
        config: { entryNodeIds: ["a"], exitNodeIds: ["c"] },
      },
    };
  }

  function child(
    id: string,
    y: number,
    config?: Record<string, unknown>
  ): WorkflowNode {
    return {
      ...actionNode(id, { x: 12, y }),
      parentId: "g",
      extent: "parent",
      selected: false,
      data: {
        label: id,
        type: "action",
        ...(config ? { config } : {}),
      },
    };
  }

  it("expands a selected frame to its children and remaps parentId on clone", () => {
    const extracted = extractCopyableSelection({
      nodes: [
        groupNode(),
        child("a", 48, { actionType: "fountain/get-user" }),
        child("c", 112, { actionType: "Condition" }),
      ],
      edges: [edge("e-a-c", "a", "c")],
    });
    if (!extracted) {
      throw new Error("expected a copyable group");
    }

    expect(extracted.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "c",
      "g",
    ]);
    expect(extracted.edges.map((item) => item.id)).toEqual(["e-a-c"]);

    const cloned = cloneSelection(extracted, {
      offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
      createId: sequentialIds(["g2", "a2", "c2", "e2"]),
    });

    const frame = cloned.nodes.find((node) => node.data.type === "group");
    const nested = cloned.nodes.filter((node) => node.parentId);
    expect(frame?.id).toBe("g2");
    expect(frame?.position).toEqual({
      x: 40 + PASTE_OFFSET,
      y: 80 + PASTE_OFFSET,
    });
    expect(frame?.data.config).toEqual({
      entryNodeIds: ["a2"],
      exitNodeIds: ["c2"],
    });
    expect(nested.every((node) => node.parentId === "g2")).toBe(true);
    expect(nested.map((node) => node.position)).toEqual([
      { x: 12, y: 48 },
      { x: 12, y: 112 },
    ]);
  });

  it("copies the whole group when a child is the context target", () => {
    const nodes = [
      { ...groupNode(), selected: false },
      child("a", 48),
      child("c", 112),
    ];
    expect([...nodeIdsForContextCopy(nodes, "a")].sort()).toEqual([
      "a",
      "c",
      "g",
    ]);
  });
});

describe("offsetToOrigin", () => {
  it("translates the bounding-box origin onto the given point", () => {
    expect(
      offsetToOrigin(
        [
          actionNode("a", { x: 100, y: 50 }),
          actionNode("b", { x: 140, y: 90 }),
        ],
        { x: 10, y: 20 }
      )
    ).toEqual({ x: -90, y: -30 });
  });
});
