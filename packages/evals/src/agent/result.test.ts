import { describe, expect, it } from "vitest";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import type { AgentDocument } from "@wfgraph/agent/document";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { collectAgentEvalResult } from "#src/agent/result";

const initialDocument: AgentDocument = {
  nodes: [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    },
  ],
  edges: [],
};

describe("collectAgentEvalResult", () => {
  it("returns the last graph and an ordered tool transcript", () => {
    const updatedDocument: AgentDocument = {
      nodes: [
        ...initialDocument.nodes,
        {
          id: "notify",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Notify",
            type: "action",
            config: { actionType: "slack/send-message" },
          },
        },
      ],
      edges: [],
    };
    const parts: AgentStreamPart[] = [
      {
        type: "tool-call",
        id: "call-1",
        name: "add_node",
        input: { actionId: "slack/send-message", label: "Notify" },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "add_node",
        summary: "Added Notify.",
        failed: false,
      },
      {
        type: "graph",
        graph: createSerializedWorkflowGraph({
          nodes: [...updatedDocument.nodes],
          edges: [...updatedDocument.edges],
        }),
      },
      { type: "text-delta", id: "text-1", delta: "Workflow " },
      { type: "text-delta", id: "text-1", delta: "updated." },
    ];

    expect(collectAgentEvalResult(initialDocument, parts)).toEqual({
      finalDocument: updatedDocument,
      finalText: "Workflow updated.",
      errors: [],
      events: [
        {
          type: "tool_call",
          id: "call-1",
          name: "add_node",
          arguments: {
            actionId: "slack/send-message",
            label: "Notify",
          },
        },
        {
          type: "tool_result",
          toolCallId: "call-1",
          name: "add_node",
          content: { summary: "Added Notify." },
        },
        {
          type: "message",
          role: "assistant",
          content: "Workflow updated.",
        },
      ],
    });
  });

  it("uses only assistant text after the final tool result as the final response", () => {
    const parts: AgentStreamPart[] = [
      { type: "text-delta", id: "text-1", delta: "I will add the step. " },
      {
        type: "tool-call",
        id: "call-1",
        name: "add_node",
        input: { actionId: "slack/send-message", label: "Notify" },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "add_node",
        summary: "Added Notify.",
        failed: false,
      },
      { type: "text-delta", id: "text-2", delta: "The workflow is ready." },
    ];

    const result = collectAgentEvalResult(initialDocument, parts);

    expect(result.finalText).toBe("The workflow is ready.");
    expect(result.events).toEqual(
      expect.arrayContaining([
        {
          type: "message",
          role: "assistant",
          content: "I will add the step. ",
        },
        {
          type: "message",
          role: "assistant",
          content: "The workflow is ready.",
        },
      ])
    );
  });

  it("uses all assistant text when the turn has no tool result", () => {
    const parts: AgentStreamPart[] = [
      { type: "text-delta", id: "text-1", delta: "I need more detail. " },
      {
        type: "text-delta",
        id: "text-1",
        delta: "Which channel should I use?",
      },
    ];

    expect(collectAgentEvalResult(initialDocument, parts).finalText).toBe(
      "I need more detail. Which channel should I use?"
    );
  });

  it("keeps the initial graph and records tool and stream failures", () => {
    const parts: AgentStreamPart[] = [
      {
        type: "tool-call",
        id: "call-1",
        name: "connect_nodes",
        input: { source: "entry", target: "entry" },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "connect_nodes",
        summary: "A step cannot flow into itself.",
        failed: true,
      },
      { type: "error", message: "The agent reached its step limit." },
    ];

    expect(collectAgentEvalResult(initialDocument, parts)).toMatchObject({
      finalDocument: initialDocument,
      finalText: "",
      errors: ["The agent reached its step limit."],
      events: [
        expect.objectContaining({ type: "tool_call", id: "call-1" }),
        {
          type: "tool_result",
          toolCallId: "call-1",
          name: "connect_nodes",
          error: {
            message: "A step cannot flow into itself.",
            type: "tool_refusal",
          },
        },
      ],
    });
  });
});
