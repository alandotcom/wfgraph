import { describe, expect, it } from "vitest";
import { Response } from "effect/unstable/ai";
import {
  summarizeToolResult,
  toAgentStreamPart,
} from "#src/backend/agent/stream";

/**
 * The mapping is a pure function over one response part, so real parts built by
 * the AI runtime's own constructor are the whole fixture. Building them rather
 * than asserting a shape is what keeps this test honest if the part shapes move.
 */
const part = Response.makePart;

describe("toAgentStreamPart", () => {
  it("carries prose through as a text delta", () => {
    expect(
      toAgentStreamPart(
        part("text-delta", { id: "t1", delta: "Adding a step" })
      )
    ).toEqual({ type: "text-delta", id: "t1", delta: "Adding a step" });
  });

  it("carries reasoning through under its own type", () => {
    expect(
      toAgentStreamPart(
        part("reasoning-delta", { id: "r1", delta: "thinking" })
      )
    ).toEqual({ type: "reasoning-delta", id: "r1", delta: "thinking" });
  });

  it("reads a tool call's arguments as the JSON the model filled in", () => {
    expect(
      toAgentStreamPart(
        part("tool-call", {
          id: "c1",
          name: "add_node",
          params: { actionId: "slack/send-message", label: "Notify" },
          providerExecuted: false,
        })
      )
    ).toEqual({
      type: "tool-call",
      id: "c1",
      name: "add_node",
      input: { actionId: "slack/send-message", label: "Notify" },
    });
  });

  it("shows a write tool's own summary beside the call", () => {
    expect(
      toAgentStreamPart(
        part("tool-result", {
          id: "c1",
          name: "add_node",
          result: { nodeId: "abc", summary: "Added Notify as abc." },
          encodedResult: { nodeId: "abc", summary: "Added Notify as abc." },
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
        })
      )
    ).toEqual({
      type: "tool-result",
      id: "c1",
      name: "add_node",
      summary: "Added Notify as abc.",
      failed: false,
    });
  });

  it("shows the reason a refused call gave, and marks it failed", () => {
    expect(
      toAgentStreamPart(
        part("tool-result", {
          id: "c2",
          name: "connect_nodes",
          result: { reason: "A step cannot flow into itself." },
          encodedResult: { reason: "A step cannot flow into itself." },
          isFailure: true,
          providerExecuted: false,
          preliminary: false,
        })
      )
    ).toMatchObject({
      summary: "A step cannot flow into itself.",
      failed: true,
    });
  });

  it("renders an error part as a sentence", () => {
    expect(
      toAgentStreamPart(
        part("error", { error: new Error("the model refused") })
      )
    ).toEqual({ type: "error", message: "the model refused" });
  });

  it("drops the parts the panel rebuilds for itself", () => {
    const dropped = [
      part("text-start", { id: "t1" }),
      part("text-end", { id: "t1" }),
      part("reasoning-start", { id: "r1" }),
      part("reasoning-end", { id: "r1" }),
      part("tool-params-start", {
        id: "c1",
        name: "add_node",
        providerExecuted: false,
      }),
      part("tool-params-delta", { id: "c1", delta: '{"label"' }),
      part("tool-params-end", { id: "c1" }),
      part("finish", {
        reason: "stop",
        usage: { inputTokens: {}, outputTokens: {} },
      }),
    ];

    for (const structural of dropped) {
      expect(toAgentStreamPart(structural), structural.type).toBeUndefined();
    }
  });
});

describe("summarizeToolResult", () => {
  it("falls back to naming the tool when a read answers only data", () => {
    expect(
      summarizeToolResult({
        name: "list_actions",
        result: { actions: [], categories: [], totalInCatalog: 0 },
        isFailure: false,
      })
    ).toBe("Read list_actions.");
  });

  it("falls back to naming the tool when a refusal carries no reason", () => {
    expect(
      summarizeToolResult({
        name: "add_node",
        result: "something went wrong",
        isFailure: true,
      })
    ).toBe("add_node failed.");
  });
});
