import { describe, expect, it } from "vitest";
import {
  connectionHandleTypesMatch,
  connectionRefusalReason,
} from "#src/components/workflow/connection-validation";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: {} },
  };
}

describe("connectionRefusalReason", () => {
  it("explains why a step cannot connect to itself", () => {
    const node = actionNode("Send message");

    expect(
      connectionRefusalReason({
        connection: {
          source: node.id,
          target: node.id,
          sourceHandle: null,
          targetHandle: null,
        },
        nodes: [node],
        edges: [],
        storeEdges: [],
        catalog: emptyExtensionCatalog,
      })
    ).toBe("Connect this step to a different step.");
  });

  it("explains when the same outlet is already connected", () => {
    const source = actionNode("Source");
    const target = actionNode("Target");
    const edge = { id: "edge", source: source.id, target: target.id };

    expect(
      connectionRefusalReason({
        connection: {
          source: source.id,
          target: target.id,
          sourceHandle: null,
          targetHandle: null,
        },
        nodes: [source, target],
        edges: [edge],
        storeEdges: [edge],
        catalog: emptyExtensionCatalog,
      })
    ).toBe("These steps are already connected from this outlet.");
  });

  it("rejects the editor-only Add step placeholder", () => {
    const source = actionNode("Source");
    const addNode: WorkflowNode = {
      id: "add",
      type: "add",
      position: { x: 0, y: 0 },
      data: { label: "Add step", type: "action" },
    };

    expect(
      connectionRefusalReason({
        connection: {
          source: source.id,
          target: addNode.id,
          sourceHandle: null,
          targetHandle: null,
        },
        nodes: [source, addNode],
        edges: [],
        storeEdges: [],
        catalog: emptyExtensionCatalog,
      })
    ).toBe("Connect to a workflow step rather than the Add step control.");
  });
});

describe("connectionHandleTypesMatch", () => {
  it("accepts opposite handle types and rejects matching types", () => {
    expect(connectionHandleTypesMatch("source", "target")).toBe(true);
    expect(connectionHandleTypesMatch("target", "source")).toBe(true);
    expect(connectionHandleTypesMatch("source", "source")).toBe(false);
    expect(connectionHandleTypesMatch("target", "target")).toBe(false);
  });
});
