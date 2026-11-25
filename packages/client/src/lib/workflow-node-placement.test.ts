import { describe, expect, it } from "vitest";
import {
  canvasObstacles,
  positionClearOfNodes,
} from "#src/lib/workflow-node-placement";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import { rectanglesOverlap } from "@wfgraph/shared/graph/node-placement";

function at(x: number, y: number) {
  return {
    x,
    y,
    width: WORKFLOW_NODE_WIDTH,
    height: WORKFLOW_NODE_HEIGHT,
  };
}

describe("positionClearOfNodes", () => {
  it("leaves an empty stretch of canvas alone", () => {
    expect(positionClearOfNodes({ x: 100, y: 200 }, [])).toEqual({
      x: 100,
      y: 200,
    });
  });

  /**
   * The rule this replaced compared top-left corners against a 20px threshold,
   * so a node 21px away counted as clear and the new step landed on top of it,
   * overlapping by nearly its whole width. Both offsets here are past that
   * threshold and well inside a node's own box.
   */
  it("moves off a node it would overlap but whose corner is 21px away", () => {
    const placed = positionClearOfNodes({ x: 21, y: 21 }, [at(0, 0)]);

    expect(placed).not.toEqual({ x: 21, y: 21 });
    expect(
      Math.abs(placed.x) >= WORKFLOW_NODE_WIDTH ||
        Math.abs(placed.y) >= WORKFLOW_NODE_HEIGHT
    ).toBe(true);
  });

  it("steps down and to the right until it is clear of a run of nodes", () => {
    const placed = positionClearOfNodes({ x: 0, y: 0 }, [
      at(0, 0),
      at(20, 20),
      at(40, 40),
    ]);

    // Eight 20px steps, which is what it takes to clear the last of the three
    // by a node's own height.
    expect(placed).toEqual({ x: 160, y: 160 });
  });

  it("ignores a node far enough away on either axis", () => {
    expect(
      positionClearOfNodes({ x: 0, y: 0 }, [at(WORKFLOW_NODE_WIDTH, 0)])
    ).toEqual({ x: 0, y: 0 });
    expect(
      positionClearOfNodes({ x: 0, y: 0 }, [at(0, WORKFLOW_NODE_HEIGHT)])
    ).toEqual({ x: 0, y: 0 });
  });

  it("walks beyond a dense run until the candidate is clear", () => {
    const crowded = Array.from({ length: 60 }, (_, index) =>
      at(index * 20, index * 20)
    );

    const placed = positionClearOfNodes({ x: 0, y: 0 }, crowded);
    expect(
      crowded.some(
        (node) =>
          placed.x < node.x + node.width &&
          placed.x + WORKFLOW_NODE_WIDTH > node.x &&
          placed.y < node.y + node.height &&
          placed.y + WORKFLOW_NODE_HEIGHT > node.y
      )
    ).toBe(false);
  });

  it("uses the occupied node's measured width", () => {
    const placed = positionClearOfNodes({ x: 250, y: 0 }, [
      { x: 0, y: 0, width: 400, height: WORKFLOW_NODE_HEIGHT },
    ]);

    expect(placed).not.toEqual({ x: 250, y: 0 });
  });

  it("escapes a group larger than the old cascade limit", () => {
    const placed = positionClearOfNodes({ x: 0, y: 0 }, [
      { x: 0, y: 0, width: 1000, height: 1000 },
    ]);

    expect(placed.x >= 1000 || placed.y >= 1000).toBe(true);
  });
});

describe("canvasObstacles", () => {
  it("resolves a child position relative to its parent", () => {
    const obstacles = canvasObstacles({
      nodes: [
        {
          id: "group",
          type: "group",
          position: { x: 500, y: 300 },
          width: 420,
          height: 260,
          data: { label: "Group", type: "group" },
        },
        {
          id: "child",
          type: "action",
          parentId: "group",
          position: { x: 20, y: 40 },
          measured: { width: 188, height: 56 },
          data: { label: "Child", type: "action", config: {} },
        },
      ],
      edges: [],
    });

    expect(obstacles).toContainEqual(
      grown({ x: 520, y: 340, width: 188, height: 56 })
    );
  });

  it("prefers React Flow's absolute position", () => {
    const obstacles = canvasObstacles({
      nodes: [
        {
          id: "child",
          type: "action",
          parentId: "group",
          position: { x: 20, y: 40 },
          data: { label: "Child", type: "action", config: {} },
        },
      ],
      edges: [],
      absolutePositionForId: () => ({ x: 720, y: 440 }),
    });

    expect(obstacles[0]).toMatchObject(grown(at(720, 440)));
  });

  // The palette once put a new card 1px from a neighbour, which read as one
  // card wider than the rest.
  it("keeps half the layout's gaps between a new step and a card", () => {
    const obstacles = canvasObstacles({
      nodes: [actionNode("a", 0, 0)],
      edges: [],
    });

    const besideIt = { x: WORKFLOW_NODE_WIDTH + 1, y: 0 };
    expect(positionClearOfNodes(besideIt, obstacles)).not.toEqual(besideIt);
    const sibling = { x: WORKFLOW_NODE_WIDTH + NODE_SPACING, y: 0 };
    expect(positionClearOfNodes(sibling, obstacles)).toEqual(sibling);
  });

  it("keeps a new step off a connection and the label on it", () => {
    const obstacles = canvasObstacles({
      nodes: [actionNode("a", 0, 0), actionNode("b", 600, 400)],
      edges: [{ source: "a", target: "b" }],
    });

    // Between the two ranks and between the two columns, where the connection
    // turns and draws its label.
    const onTheConnection = { x: 250, y: 140 };
    const placed = positionClearOfNodes(onTheConnection, obstacles);
    expect(placed).not.toEqual(onTheConnection);
    expect(
      obstacles.some((obstacle) =>
        rectanglesOverlap(obstacle, at(placed.x, placed.y))
      )
    ).toBe(false);
  });

  it("leaves the slot one rank below a step open", () => {
    const obstacles = canvasObstacles({
      nodes: [actionNode("a", 0, 0)],
      edges: [],
    });

    const below = { x: 0, y: WORKFLOW_NODE_HEIGHT + RANK_SPACING };
    expect(positionClearOfNodes(below, obstacles)).toEqual(below);
  });
});

function actionNode(id: string, x: number, y: number) {
  return {
    id,
    type: "action",
    position: { x, y },
    data: { label: id, type: "action" as const, config: {} },
  };
}

function grown(rectangle: ReturnType<typeof at>) {
  return {
    x: rectangle.x - NODE_SPACING / 2,
    y: rectangle.y - RANK_SPACING / 2,
    width: rectangle.width + NODE_SPACING,
    height: rectangle.height + RANK_SPACING,
  };
}
