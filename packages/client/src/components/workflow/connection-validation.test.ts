import { describe, expect, it } from "vitest";
import {
  connectionHandleTypesMatch,
  connectionRefusalReason,
} from "#src/components/workflow/connection-validation";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
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

  it("connects a member to another member or straight to a step outside its Group", () => {
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
    expect(refusal(first.id, outside.id)).toBeNull();
    expect(refusal(outside.id, second.id)).toBeNull();
  });
});

describe("connectionRefusalReason for a second entry into a Group", () => {
  const frame: WorkflowNode = {
    id: "group",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Group", type: "group" },
  };
  const member = (id: string): WorkflowNode => ({
    ...actionNode(id),
    parentId: "group",
  });
  const builtIn = (id: string, actionType: string): WorkflowNode => ({
    ...actionNode(id),
    data: { label: id, type: "action", config: { actionType } },
  });

  /**
   * The outlet `handle` of `outside` already enters the member `first`; the
   * graph and the connection from that same outlet onto the member `second`.
   */
  function fanOutFrom(outside: WorkflowNode, handle: string) {
    const nodes = [outside, frame, member("first"), member("second")];
    const storeEdges: WorkflowEdge[] = [
      { id: "in", source: outside.id, target: "first", sourceHandle: handle },
    ];
    const connection = {
      source: outside.id,
      target: "second",
      sourceHandle: handle,
      targetHandle: null,
    };
    return { nodes, storeEdges, connection };
  }

  it("accepts a fan-out from a Condition branch and keeps the branch", () => {
    const { nodes, storeEdges, connection } = fanOutFrom(
      builtIn("check", BUILT_IN_ACTION_IDS.condition),
      "false"
    );

    expect(
      connectionRefusalReason({
        connection,
        nodes,
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBeNull();
    expect(
      connectionRefusalReason({
        connection: { source: "Outside", target: "second" },
        nodes: [...nodes, actionNode("Outside")],
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'The Group "Group" is already entered from the "False" outlet of "check". A Group is entered from one outlet, so remove that connection first.'
    );
  });

  it("accepts a fan-out from an Event Split outlet and keeps the outlet", () => {
    const { nodes, storeEdges, connection } = fanOutFrom(
      builtIn("split", BUILT_IN_ACTION_IDS.eventSplit),
      "event:signup"
    );

    expect(
      connectionRefusalReason({
        connection,
        nodes,
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBeNull();
    expect(
      connectionRefusalReason({
        connection: { source: "Outside", target: "second" },
        nodes: [...nodes, actionNode("Outside")],
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'The Group "Group" is already entered from the "signup" outlet of "split". A Group is entered from one outlet, so remove that connection first.'
    );
  });
});
