import { describe, expect, it } from "vitest";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import {
  toEditorEdge,
  toPersistedEdge,
  WORKFLOW_EDGE_TYPE,
} from "#src/lib/workflow-graph-types";
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";

function node(id: string): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action" },
  };
}

/**
 * The reload path: what the editor holds is saved, read back from the wire, and
 * turned into editor edges again. A page refresh runs exactly this.
 */
function reload(edges: WorkflowEdge[]): WorkflowEdge[] {
  const graph = createSerializedWorkflowGraph({
    nodes: [node("a"), node("b")],
    edges: edges.map(toPersistedEdge),
  });
  return toWorkflowGraphData(graph).edges.map(toEditorEdge);
}

describe("toEditorEdge", () => {
  it("paints a reloaded edge with the canvas edge type", () => {
    const reloaded = reload([
      { id: "e1", source: "a", target: "b", type: WORKFLOW_EDGE_TYPE },
    ]);

    expect(reloaded[0]?.type).toBe(WORKFLOW_EDGE_TYPE);
  });

  it("paints an edge that was stored without one", () => {
    const reloaded = reload([{ id: "e1", source: "a", target: "b" }]);

    expect(reloaded[0]?.type).toBe(WORKFLOW_EDGE_TYPE);
  });

  it("keeps the handle a Condition branch left by", () => {
    const reloaded = reload([
      { id: "e1", source: "a", target: "b", sourceHandle: "false" },
    ]);

    expect(reloaded[0]?.sourceHandle).toBe("false");
  });
});
