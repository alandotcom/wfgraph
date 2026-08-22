import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { rejectUnknownKeys } from "#src/types/schema";
import { formatSchemaFailure } from "#src/types/schema-message";
import {
  createSerializedWorkflowGraph,
  parseSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "#src/graph/graph";
import { workflowNodeDataSchema } from "#src/graph/schemas";

/** A one-node graph, in the shape `graph.export()` hands over. */
function graphWithNode(attributes: unknown) {
  return {
    attributes: {},
    options: { allowSelfLoops: false, multi: false, type: "directed" },
    nodes: [{ key: "n1", attributes }],
    edges: [],
  };
}

describe("a graph built in process", () => {
  // The editor's autosave path decodes what React Flow state produced, and an
  // object TypeScript wrote says "no value" by holding `undefined`. These two
  // are the shapes that were rejected while the schemas used `optionalKey`,
  // the second of which is the already-fixed duplicate bug arriving by
  // another road.
  it("accepts a node whose optional data field holds undefined", () => {
    const parsed = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "Send email", type: "action", description: undefined },
      })
    );

    expect(parsed.nodes).toHaveLength(1);
  });

  it("accepts an entry node config whose optional field holds undefined", () => {
    const parsed = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: {
          label: "Webhook",
          type: "lifecycle",
          config: { lifecycleRules: undefined },
        },
      })
    );

    expect(parsed.nodes).toHaveLength(1);
  });

  // The samples the Test Run overlay keeps sit on the entry node beside the
  // rules, so a save carries them and a duplicated workflow opens on them.
  it("accepts an entry node carrying test-run payloads", () => {
    const parsed = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: {
          label: "Appointment",
          type: "lifecycle",
          config: {
            testPayloads: {
              byEvent: {
                "app/appointment.created": { appointment: { id: "appt_1" } },
              },
              manual: undefined,
            },
          },
        },
      })
    );

    expect(parsed.nodes).toHaveLength(1);
  });

  // The outer `type` attribute is what React Flow's `nodeTypes` map dispatches
  // on, and `data.type` is what every validator and the engine read. The two
  // must agree on the same four-arm union, or a graph can decode clean while
  // carrying a node React Flow renders as its unstyled default.
  it("rejects a node whose outer type disagrees with data.type", () => {
    expect(() =>
      parseSerializedWorkflowGraph(
        graphWithNode({
          id: "n1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: { label: "Webhook", type: "lifecycle", config: {} },
        })
      )
    ).toThrow();
  });

  // Chosen, not inherited: a position holding Infinity is corruption, and the
  // save store treats a graph it cannot decode as nothing to save.
  it("rejects a node position that is not finite", () => {
    expect(() =>
      parseSerializedWorkflowGraph(
        graphWithNode({
          id: "n1",
          position: { x: Number.POSITIVE_INFINITY, y: 0 },
          data: { label: "Send email", type: "action" },
        })
      )
    ).toThrow(/finite/);
  });
});

describe("persisted node data", () => {
  it("strips run status when encoding and when loading", () => {
    const encoded = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "n1",
          position: { x: 0, y: 0 },
          data: {
            label: "Send email",
            type: "action",
            status: "running",
            config: { actionType: "resend/send-email" },
          },
        },
      ],
      edges: [],
    });

    expect(encoded.nodes[0]?.attributes.data).not.toHaveProperty("status");

    const loaded = toWorkflowGraphData(
      parseSerializedWorkflowGraph(
        graphWithNode({
          id: "n1",
          position: { x: 0, y: 0 },
          data: {
            label: "Send email",
            type: "action",
            status: "success",
            config: { actionType: "resend/send-email" },
          },
        })
      )
    );

    expect(loaded.nodes[0]?.data).not.toHaveProperty("status");
    expect(loaded.nodes[0]?.data.config).toMatchObject({
      actionType: "resend/send-email",
    });
  });

  it("round-trips a Group frame and a child's parentId", () => {
    const encoded = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "g1",
          type: "group",
          position: { x: 10, y: 20 },
          width: 212,
          height: 180,
          data: {
            label: "Lookups",
            type: "group",
            config: { entryNodeIds: ["a1"], exitNodeIds: ["c1"] },
          },
        },
        {
          id: "a1",
          type: "action",
          position: { x: 12, y: 48 },
          parentId: "g1",
          data: {
            label: "Get User",
            type: "action",
            config: { actionType: "fountain/get-user" },
          },
        },
      ],
      edges: [],
    });

    const loaded = toWorkflowGraphData(encoded);
    expect(loaded.nodes[0]?.data.type).toBe("group");
    expect(loaded.nodes[0]?.width).toBe(212);
    expect(loaded.nodes[1]?.parentId).toBe("g1");
  });

  it("rejects the singular Group exit field", () => {
    expect(() =>
      createSerializedWorkflowGraph({
        nodes: [
          {
            id: "g1",
            type: "group",
            position: { x: 10, y: 20 },
            data: {
              label: "Lookups",
              type: "group",
              config: { entryNodeIds: ["a1"], exitNodeId: "a1" },
            },
          },
        ],
        edges: [],
      })
    ).toThrow();
  });

  it("accepts a closed Condition config and rejects a stray key", () => {
    const ok = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: {
          label: "If",
          type: "action",
          config: { actionType: "Condition", condition: "true" },
        },
      })
    );
    expect(ok.nodes).toHaveLength(1);

    expect(() =>
      parseSerializedWorkflowGraph(
        graphWithNode({
          id: "n1",
          position: { x: 0, y: 0 },
          data: {
            label: "If",
            type: "action",
            config: {
              actionType: "Condition",
              condition: "true",
              stray: true,
            },
          },
        })
      )
    ).toThrow(/stray|Unexpected key/i);
  });

  it("keeps plugin action fields in the open config arm", () => {
    const parsed = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: {
          label: "Email",
          type: "action",
          config: {
            actionType: "resend/send-email",
            integrationId: "int_1",
            to: "a@example.com",
          },
        },
      })
    );

    expect(parsed.nodes[0]?.attributes.data.config).toMatchObject({
      actionType: "resend/send-email",
      to: "a@example.com",
    });
  });
});

describe("node data failure messages", () => {
  const readNodeData = Schema.decodeUnknownResult(workflowNodeDataSchema, {
    ...rejectUnknownKeys,
    errors: "all",
  });

  function messageFor(value: unknown): string {
    const result = readNodeData(value);
    if (Result.isSuccess(result)) {
      throw new Error("expected the decode to fail");
    }
    return formatSchemaFailure(result.failure.issue);
  }

  // One literal `type` per union arm is what lets Effect pick the arm the
  // input was aiming at. Without it every arm is tried and every arm
  // complains, which would report a bad Lifecycle Node config beside a demand
  // that `type` be "action" or "add". The entry node's config is one closed
  // struct, so its own field is the whole of what a reader is told.
  it("names the Lifecycle Node's own problem and not the other arms", () => {
    const message = messageFor({
      label: "Webhook",
      type: "lifecycle",
      config: { lifecycleRules: 42 },
    });

    expect(message).not.toContain('"action"');
    expect(message).toBe(
      "config.lifecycleRules: Expected an object | undefined"
    );
  });

  // The entry node's config is closed, and `triggerType` is the key every graph
  // saved before this batch carries: it fails by name, which is what tells a
  // reader the shape changed rather than the value being wrong.
  it("names triggerType as the excess key it now is", () => {
    const message = messageFor({
      label: "Webhook",
      type: "lifecycle",
      config: { triggerType: "Webhook" },
    });

    expect(message).toContain("config.triggerType");
    expect(message).toContain("Unexpected key");
  });

  // Retired waitMode "hook" fails at the graph boundary so autosave never
  // parks a shape the engine would refuse.
  it("refuses a Wait node still configured for the retired hook mode", () => {
    const message = messageFor({
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "hook",
        waitHookToken: "token_abc",
      },
    });

    expect(message).toContain("waitMode");
    expect(message).not.toContain("token_abc");
  });

  it("keeps the rejected node data out of the message", () => {
    const message = messageFor({
      label: "Webhook",
      config: { secret: "sk-live-do-not-echo-this" },
    });

    expect(message).not.toContain("sk-live-do-not-echo-this");
    expect(message).toBe(
      '<root>: Node data needs a type of "lifecycle", "action", "add", or "group"'
    );
  });
});
