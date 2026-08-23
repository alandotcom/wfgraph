import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
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
const eventSplit = actionNode("event-split", "Event Split");

const firstToSecond: WorkflowEdge = {
  id: "e1",
  source: "first",
  target: "second",
};

describe("add_node", () => {
  it.effect("adds an action node carrying its action type", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      const result = yield* tools.add_node({
        actionId: "slack/send-message",
        label: "Notify the team",
        description: "Tell #hiring.",
        config: [{ key: "channel", value: "#hiring" }],
      });

      const document = yield* draft.current;
      const node = document.nodes.find(
        (candidate) => candidate.id === result.nodeId
      );
      expect(document.nodes).toHaveLength(2);
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
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });

      for (const actionId of ["Condition", "Wait", "Event Split"]) {
        yield* tools.add_node({ actionId, label: actionId });
      }

      const document = yield* draft.current;
      expect(
        document.nodes.flatMap((node) => actionTypeOf(node) ?? [])
      ).toEqual(["Condition", "Wait", "Event Split"]);
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

  it.effect("refuses config that tries to replace the action id", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.add_node({
          actionId: "slack/send-message",
          label: "Notify",
          config: [{ key: "actionType", value: "score-applicant" }],
        })
      );

      expect(failure.reason).toContain("actionType");
      expect((yield* draft.current).nodes).toEqual([entry]);
    })
  );

  it.effect("leaves the node unplaced for the editor to lay out", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      yield* tools.add_node({ actionId: "score-applicant", label: "Score" });

      expect((yield* draft.current).nodes[1]?.position).toEqual({ x: 0, y: 0 });
    })
  );
});

describe("update_node", () => {
  it.effect("merges config over what the node already holds", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, second],
        catalog,
      });
      yield* tools.update_node({
        nodeId: "second",
        label: "Announce",
        config: [{ key: "channel", value: "#general" }],
      });

      const node = (yield* draft.current).nodes.find(
        (candidate) => candidate.id === "second"
      );
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
        nodes: [entry, withChannel],
        catalog,
      });
      yield* tools.update_node({
        nodeId: "second",
        clearConfigKeys: ["channel"],
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
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

  it.effect("refuses config that changes or clears the action id", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, second],
        catalog,
      });

      const changed = yield* Effect.flip(
        tools.update_node({
          nodeId: "second",
          config: [{ key: "actionType", value: "score-applicant" }],
        })
      );
      const cleared = yield* Effect.flip(
        tools.update_node({
          nodeId: "second",
          clearConfigKeys: ["actionType"],
        })
      );

      expect(changed.reason).toContain("actionType");
      expect(cleared.reason).toContain("actionType");
      expect((yield* draft.current).nodes[1]).toEqual(second);
    })
  );

  it.effect("keeps Lifecycle config behind the lifecycle tool", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.update_node({
          nodeId: "entry",
          config: [{ key: "channel", value: "#general" }],
        })
      );

      expect(failure.reason).toContain("set_lifecycle_rules");
      expect((yield* draft.current).nodes).toEqual([entry]);
    })
  );
});

describe("delete_node", () => {
  it.effect("takes every edge touching the node with it", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, first, second],
        edges: [firstToSecond],
        catalog,
      });
      const result = yield* tools.delete_node({ nodeId: "first" });

      const document = yield* draft.current;
      expect(document.nodes.map((node) => node.id)).toEqual([
        "entry",
        "second",
      ]);
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

  it.effect("refuses to remove the only Lifecycle Node", () =>
    Effect.gen(function* () {
      const started: WorkflowEdge = {
        id: "started",
        source: "entry",
        target: "first",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, first],
        edges: [started],
        catalog,
      });

      const failure = yield* Effect.flip(
        tools.delete_node({ nodeId: "entry" })
      );

      expect(failure.reason).toContain("Lifecycle Node");
      expect((yield* draft.current).nodes).toEqual([entry, first]);
      expect((yield* draft.current).edges).toEqual([started]);
    })
  );
});

describe("connect_nodes", () => {
  it.effect("draws an edge between two plain steps", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, first, second],
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
        nodes: [entry, first, second],
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
        nodes: [entry, condition, second],
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

  it.effect("holds an edge out of an Event Split to a reachable Event", () =>
    Effect.gen(function* () {
      const lifecycle: WorkflowNode = {
        ...entry,
        data: {
          ...entry.data,
          config: {
            lifecycleRules: {
              startEvents: ["applicant.created"],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: false,
            },
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        nodes: [lifecycle, eventSplit, second],
        edges: [
          {
            id: "entry-split",
            source: "entry",
            target: "event-split",
            sourceHandle: LIFECYCLE_STARTED_HANDLE,
          },
        ],
        catalog,
      });

      const wrongEvent = yield* Effect.flip(
        tools.connect_nodes({
          source: "event-split",
          target: "second",
          sourceHandle: eventSplitOutlet("applicant.withdrawn"),
        })
      );
      expect(wrongEvent.reason).toContain("does not reach");

      yield* tools.connect_nodes({
        source: "event-split",
        target: "second",
        sourceHandle: eventSplitOutlet("applicant.created"),
      });
      expect((yield* draft.current).edges[1]?.sourceHandle).toBe(
        "event:applicant.created"
      );
    })
  );

  it.effect("refuses an outlet name on a step that has none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [entry, first, second],
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

  it.effect("refuses joining the true and false paths of a Condition", () =>
    Effect.gen(function* () {
      const trueAction = actionNode("true-action", "slack/send-message");
      const afterCondition = actionNode("after-condition", "linear/create");
      const edges: WorkflowEdge[] = [
        {
          id: "entry-condition",
          source: "entry",
          target: "branch",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        },
        {
          id: "condition-true",
          source: "branch",
          target: "true-action",
          sourceHandle: "true",
        },
        {
          id: "condition-false",
          source: "branch",
          target: "after-condition",
          sourceHandle: "false",
        },
      ];
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, condition, trueAction, afterCondition],
        edges,
        catalog,
      });

      const failure = yield* Effect.flip(
        tools.connect_nodes({
          source: "true-action",
          target: "after-condition",
        })
      );

      expect(failure.reason).toContain("mutually exclusive branches");
      expect((yield* draft.current).edges).toEqual(edges);
    })
  );
});

describe("disconnect_nodes", () => {
  it.effect("removes the edge and leaves both steps", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry, first, second],
        edges: [firstToSecond],
        catalog,
      });
      yield* tools.disconnect_nodes({ edgeId: "e1" });

      const document = yield* draft.current;
      expect(document.edges).toEqual([]);
      expect(document.nodes).toHaveLength(3);
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
