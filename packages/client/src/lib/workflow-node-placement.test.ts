import { describe, expect, it } from "vitest";
import { positionClearOfNodes } from "#src/lib/workflow-node-placement";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

function at(x: number, y: number) {
  return { position: { x, y } };
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

  it("gives up rather than walking forever across a dense graph", () => {
    // A node every 20px along the diagonal, further than the walk can escape.
    const crowded = Array.from({ length: 60 }, (_, index) =>
      at(index * 20, index * 20)
    );

    expect(positionClearOfNodes({ x: 0, y: 0 }, crowded)).toEqual({
      x: 400,
      y: 400,
    });
  });
});
