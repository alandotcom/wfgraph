import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "#src/graph/graph";
import type { WorkflowNode } from "#src/graph/types";
import {
  agentChatInputSchema,
  MAX_AGENT_GRAPH_EDGES,
  MAX_AGENT_GRAPH_NODES,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_REQUEST_CHARS,
} from "#src/rpc/contracts";
import { rejectUnknownKeys } from "#src/types/schema";

const decode = Schema.decodeUnknownResult(
  agentChatInputSchema,
  rejectUnknownKeys
);

function lifecycleNode(id: string, label = "Lifecycle"): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label, type: "lifecycle", config: {} },
  };
}

const graph = createSerializedWorkflowGraph({
  nodes: [lifecycleNode("lifecycle")],
  edges: [],
});

describe("agentChatInputSchema", () => {
  it("bounds the conversation length", () => {
    const result = decode({
      workflowId: "workflow_1",
      messages: Array.from({ length: MAX_AGENT_MESSAGES + 1 }, () => ({
        role: "user",
        content: "Build it",
      })),
      graph,
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  it("bounds each conversation message", () => {
    const result = decode({
      workflowId: "workflow_1",
      messages: [
        { role: "user", content: "x".repeat(MAX_AGENT_MESSAGE_CHARS + 1) },
      ],
      graph,
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  it("bounds graph node and edge counts", () => {
    const nodes = Array.from(
      { length: MAX_AGENT_GRAPH_NODES + 1 },
      (_, index) => lifecycleNode(`node_${index}`)
    );
    const edges = Array.from(
      { length: MAX_AGENT_GRAPH_EDGES + 1 },
      (_, index) => ({
        id: `edge_${index}`,
        source: "lifecycle",
        target: "lifecycle",
      })
    );

    expect(
      Result.isFailure(
        decode({
          workflowId: "workflow_1",
          messages: [],
          graph: createSerializedWorkflowGraph({ nodes, edges: [] }),
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          workflowId: "workflow_1",
          messages: [],
          graph: { ...graph, edges },
        })
      )
    ).toBe(true);
  });

  it("bounds the complete serialized request", () => {
    const oversizedGraph = createSerializedWorkflowGraph({
      nodes: [lifecycleNode("lifecycle", "x".repeat(MAX_AGENT_REQUEST_CHARS))],
      edges: [],
    });

    expect(
      Result.isFailure(
        decode({
          workflowId: "workflow_1",
          messages: [],
          graph: oversizedGraph,
        })
      )
    ).toBe(true);
  });
});
