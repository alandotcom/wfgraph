import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { rejectUnknownKeys } from "#src/types/schema";
import { formatSchemaFailure } from "#src/types/schema-message";
import { parseSerializedWorkflowGraph } from "#src/workflow/graph";
import { workflowNodeDataSchema } from "#src/workflow/schemas";

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

  it("accepts a webhook trigger config whose optional field holds undefined", () => {
    const parsed = parseSerializedWorkflowGraph(
      graphWithNode({
        id: "n1",
        position: { x: 0, y: 0 },
        data: {
          label: "Webhook",
          type: "trigger",
          config: { webhookSchema: undefined },
        },
      })
    );

    expect(parsed.nodes).toHaveLength(1);
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
  // complains, so a bad trigger config used to be reported beside a demand
  // that `type` be "action" or "add". The entry node's config is one closed
  // struct now, so its own field is the whole of what a reader is told.
  it("names the trigger arm's own problem and not the other arms", () => {
    const message = messageFor({
      label: "Webhook",
      type: "trigger",
      config: { webhookSchema: 42 },
    });

    expect(message).not.toContain('"action"');
    expect(message).toBe(
      "config.webhookSchema: Expected string | undefined, got 42"
    );
  });

  // The entry node's config is closed, and `triggerType` is the key every graph
  // saved before this batch carries: it fails by name, which is what tells a
  // reader the shape changed rather than the value being wrong.
  it("names triggerType as the excess key it now is", () => {
    const message = messageFor({
      label: "Webhook",
      type: "trigger",
      config: { triggerType: "Webhook" },
    });

    expect(message).toContain("config.triggerType");
    expect(message).toContain("Unexpected key");
  });

  it("keeps the rejected node data out of the message", () => {
    const message = messageFor({
      label: "Webhook",
      config: { secret: "sk-live-do-not-echo-this" },
    });

    expect(message).not.toContain("sk-live-do-not-echo-this");
    expect(message).toBe(
      '<root>: Node data needs a type of "trigger", "action", or "add"'
    );
  });
});
