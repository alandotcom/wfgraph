import { describe, expect, it } from "vitest";
import {
  connectionHandleTypesMatch,
  connectionRefusalReason,
} from "#src/components/workflow/connection-validation";
import {
  boundaryStubId,
  focusedGroupCanvasGraph,
  storedCanvasConnection,
} from "#src/lib/group-scope-canvas";
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

describe("connectionRefusalReason for a drag from an ingress stub", () => {
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
   * Drags from the stub for the outlet `handle` of `outside` onto the member
   * `second` on the focused Group, where that outlet already enters `first`.
   */
  function dragFromStub(outside: WorkflowNode, handle: string) {
    const nodes = [outside, frame, member("first"), member("second")];
    const storeEdges: WorkflowEdge[] = [
      { id: "in", source: outside.id, target: "first", sourceHandle: handle },
    ];
    const painted = focusedGroupCanvasGraph({
      nodes,
      edges: storeEdges,
      groupId: "group",
    });
    const translated = storedCanvasConnection(
      {
        source: boundaryStubId("ingress", { nodeId: outside.id, handle }),
        target: "second",
        sourceHandle: null,
        targetHandle: null,
      },
      painted?.nodes ?? []
    );
    if ("refusal" in translated) {
      throw new Error(translated.refusal);
    }
    return { nodes, storeEdges, translated };
  }

  it("accepts a fan-out from a Condition branch and keeps the branch", () => {
    const { nodes, storeEdges, translated } = dragFromStub(
      builtIn("check", BUILT_IN_ACTION_IDS.condition),
      "false"
    );

    expect(translated.connection).toMatchObject({
      source: "check",
      sourceHandle: "false",
    });
    expect(
      connectionRefusalReason({
        ...translated,
        nodes,
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBeNull();
    expect(
      connectionRefusalReason({
        connection: { source: "Outside", target: "second" },
        fromIngressStub: true,
        nodes: [...nodes, actionNode("Outside")],
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'The Group "Group" is already entered from the "False" outlet of "check". A Group is entered from one outlet, so remove that connection first.'
    );
  });

  it("accepts a fan-out from an Event Split outlet and keeps the outlet", () => {
    const { nodes, storeEdges, translated } = dragFromStub(
      builtIn("split", BUILT_IN_ACTION_IDS.eventSplit),
      "event:signup"
    );

    expect(translated.connection).toMatchObject({
      source: "split",
      sourceHandle: "event:signup",
    });
    expect(
      connectionRefusalReason({
        ...translated,
        nodes,
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBeNull();
    expect(
      connectionRefusalReason({
        connection: { source: "Outside", target: "second" },
        fromIngressStub: true,
        nodes: [...nodes, actionNode("Outside")],
        storeEdges,
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'The Group "Group" is already entered from the "signup" outlet of "split". A Group is entered from one outlet, so remove that connection first.'
    );
  });
});
