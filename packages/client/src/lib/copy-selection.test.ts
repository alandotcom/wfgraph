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
  return { id, source, target, type: "animated" };
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
    const cloned = cloneSelection(
      {
        nodes: [
          actionNode("a", { x: 10, y: 20 }),
          actionNode("b", { x: 30, y: 40 }),
        ],
        edges: [edge("e-a-b", "a", "b")],
      },
      {
        offset: { x: PASTE_OFFSET, y: PASTE_OFFSET },
        createId: sequentialIds(["a2", "b2", "e2"]),
      }
    );

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
        type: "animated",
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

    const cloned = cloneSelection(
      {
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
      },
      { offset: { x: 0, y: 0 }, createId: sequentialIds(["a2", "b2"]) }
    );

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
