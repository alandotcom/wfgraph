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

  it("accepts two members of one Group and refuses a member with an outside step", () => {
    const first = { ...actionNode("First"), parentId: "group" };
    const second = { ...actionNode("Second"), parentId: "group" };
    const outside = actionNode("Outside");
    const frame: WorkflowNode = {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Group", type: "group" },
    };
    const refusal = (source: string, target: string) =>
      connectionRefusalReason({
        connection: { source, target, sourceHandle: null, targetHandle: null },
        nodes: [frame, first, second, outside],
        storeEdges: [],
        catalog: emptyExtensionCatalog,
      });

    expect(refusal(first.id, second.id)).toBeNull();
    expect(refusal(first.id, outside.id)).toBe(
      "Connect two steps inside the same Group, or connect the Group card."
    );
    expect(refusal(outside.id, second.id)).toBe(
      "Connect two steps inside the same Group, or connect the Group card."
    );
  });
});
