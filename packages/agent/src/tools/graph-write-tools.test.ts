import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

function actionNode(id: string, actionType: string): WorkflowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    type: "action",
    data: { label: id, type: "action", config: { actionType } },
  };
}

const entry: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: { label: "Lifecycle", type: "lifecycle", config: {} },
};

const first = actionNode("first", "score-applicant");
const second = actionNode("second", "slack/send-message");
const condition = actionNode("branch", "Condition");

const firstToSecond: WorkflowEdge = {
  id: "e1",
  source: "first",
  target: "second",
};

describe("add_node", () => {
  it.effect("adds an action node carrying its action type", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const result = yield* tools.add_node({
        actionId: "slack/send-message",
        label: "Notify the team",
        description: "Tell #hiring.",
        config: [{ key: "channel", value: "#hiring" }],
      });

      const document = yield* draft.current;
      const [node] = document.nodes;
      expect(document.nodes).toHaveLength(1);
      expect(node?.id).toBe(result.nodeId);
      expect(node?.data).toMatchObject({
        label: "Notify the team",
        description: "Tell #hiring.",
        type: "action",
        config: { actionType: "slack/send-message", channel: "#hiring" },
      });
    })
  );

  it.effect("accepts the three built-in steps", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });

      for (const actionId of ["Condition", "Wait", "Event Split"]) {
        yield* tools.add_node({ actionId, label: actionId });
      }

      const document = yield* draft.current;
      expect(document.nodes.map((node) => actionTypeOf(node))).toEqual([
        "Condition",
        "Wait",
        "Event Split",
      ]);
    })
  );

  it.effect("refuses an action the catalog never registered", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.add_node({ actionId: "stripe/refund", label: "Refund" })
      );

      expect(failure.reason).toContain("stripe/refund");
      expect((yield* draft.current).nodes).toEqual([]);
    })
  );

  it.effect("leaves the node unplaced for the editor to lay out", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      yield* tools.add_node({ actionId: "score-applicant", label: "Score" });

      expect((yield* draft.current).nodes[0]?.position).toEqual({ x: 0, y: 0 });
    })
  );
});

describe("update_node", () => {
  it.effect("merges config over what the node already holds", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [second],
        catalog,
      });
      yield* tools.update_node({
        nodeId: "second",
        label: "Announce",
        config: [{ key: "channel", value: "#general" }],
      });

      const [node] = (yield* draft.current).nodes;
      expect(node?.data.label).toBe("Announce");
      expect(node?.data.config).toEqual({
        actionType: "slack/send-message",
        channel: "#general",
      });
    })
  );

  it.effect("removes the config keys it is told to clear", () =>
    Effect.gen(function* () {
      const withChannel: WorkflowNode = {
        ...second,
        data: {
          ...second.data,
          config: { actionType: "slack/send-message", channel: "#hiring" },
        },
      };

      const { tools, draft } = yield* agentToolsFor({
        nodes: [withChannel],
        catalog,
      });
      yield* tools.update_node({
        nodeId: "second",
        clearConfigKeys: ["channel"],
      });

      expect((yield* draft.current).nodes[0]?.data.config).toEqual({
        actionType: "slack/send-message",
      });
    })
  );

  it.effect("refuses a node the graph does not hold", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [second], catalog });
      const failure = yield* Effect.flip(
        tools.update_node({ nodeId: "ghost", label: "x" })
      );

      expect(failure.reason).toContain("ghost");
    })
  );
});

describe("delete_node", () => {
  it.effect("takes every edge touching the node with it", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [first, second],
        edges: [firstToSecond],
        catalog,
      });
      const result = yield* tools.delete_node({ nodeId: "first" });

      const document = yield* draft.current;
      expect(document.nodes.map((node) => node.id)).toEqual(["second"]);
      expect(document.edges).toEqual([]);
      expect(result.summary).toContain("1 edge");
    })
  );

  it.effect("refuses a node the graph does not hold", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [first], catalog });
      const failure = yield* Effect.flip(
        tools.delete_node({ nodeId: "ghost" })
      );

      expect(failure.reason).toContain("ghost");
    })
  );
});

describe("connect_nodes", () => {
  it.effect("draws an edge between two plain steps", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [first, second],
        catalog,
      });
      yield* tools.connect_nodes({ source: "first", target: "second" });

      const [edge] = (yield* draft.current).edges;
      expect(edge).toMatchObject({ source: "first", target: "second" });
      expect(edge?.sourceHandle).toBeUndefined();
    })
  );

  it.effect("refuses a step flowing into itself", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [first], catalog });
      const failure = yield* Effect.flip(
        tools.connect_nodes({ source: "first", target: "first" })
      );

      expect(failure.reason).toContain("cannot flow into itself");
    })
  );

  it.effect("refuses an edge that would make a loop", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [first, second],
        edges: [firstToSecond],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.connect_nodes({ source: "second", target: "first" })
      );

      expect(failure.reason).toContain("loop");
      expect((yield* draft.current).edges).toHaveLength(1);
    })
  );

  it.effect("refuses the same edge twice", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [first, second],
        edges: [firstToSecond],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.connect_nodes({ source: "first", target: "second" })
      );

      expect(failure.reason).toContain("already flows into");
    })
  );

  it.effect("holds an edge out of a Condition to a named branch", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [condition, second],
        catalog,
      });

      const failure = yield* Effect.flip(
        tools.connect_nodes({ source: "branch", target: "second" })
      );
      expect(failure.reason).toContain('"true" or "false"');

      yield* tools.connect_nodes({
        source: "branch",
        target: "second",
        sourceHandle: "true",
      });
      expect((yield* draft.current).edges[0]?.sourceHandle).toBe("true");
    })
  );

  it.effect("holds an edge out of the Lifecycle Node to an outlet", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, first],
        catalog,
      });

      const failure = yield* Effect.flip(
        tools.connect_nodes({ source: "entry", target: "first" })
      );
      expect(failure.reason).toContain("started");

      yield* tools.connect_nodes({
        source: "entry",
        target: "first",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      });
      expect((yield* draft.current).edges[0]?.sourceHandle).toBe("started");
    })
  );

  it.effect("refuses an outlet name on a step that has none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [first, second],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.connect_nodes({
          source: "first",
          target: "second",
          sourceHandle: "true",
        })
      );

      expect(failure.reason).toContain("takes no sourceHandle");
    })
  );
});

describe("disconnect_nodes", () => {
  it.effect("removes the edge and leaves both steps", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [first, second],
        edges: [firstToSecond],
        catalog,
      });
      yield* tools.disconnect_nodes({ edgeId: "e1" });

      const document = yield* draft.current;
      expect(document.edges).toEqual([]);
      expect(document.nodes).toHaveLength(2);
    })
  );

  it.effect("refuses an edge the graph does not hold", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [first], catalog });
      const failure = yield* Effect.flip(
        tools.disconnect_nodes({ edgeId: "ghost" })
      );

      expect(failure.reason).toContain("ghost");
    })
  );
});
