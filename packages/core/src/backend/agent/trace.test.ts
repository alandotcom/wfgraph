import { describe, expect, it } from "vitest";
import { Response } from "effect/unstable/ai";
import {
  finishReasonFailure,
  summarizeAgentTrace,
  traceResponsePart,
  type AgentTraceEvent,
} from "#src/backend/agent/trace";

const part = Response.makePart;

describe("traceResponsePart", () => {
  it("keeps the complete tool result and links a write to its graph revision", () => {
    const encodedResult = {
      nodeId: "notify",
      references: ["{{event.payload.customer.id}}"],
      summary: "Added Notify.",
    };

    expect(
      traceResponsePart({
        step: 2,
        graphRevision: 3,
        part: part("tool-result", {
          id: "call-1",
          name: "add_node",
          result: { ...encodedResult, createdAt: new Date("2026-09-02") },
          encodedResult,
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
        }),
      })
    ).toEqual({
      type: "tool-result",
      step: 2,
      id: "call-1",
      name: "add_node",
      result: encodedResult,
      failed: false,
      graphRevision: 3,
    });
  });

  it("records the finish reason and all provider token counts", () => {
    expect(
      traceResponsePart({
        step: 4,
        part: part("finish", {
          reason: "length",
          usage: new Response.Usage({
            inputTokens: {
              uncached: 80,
              total: 100,
              cacheRead: 20,
              cacheWrite: undefined,
            },
            outputTokens: { total: 30, text: 18, reasoning: 12 },
          }),
        }),
      })
    ).toEqual({
      type: "model-step-finish",
      step: 4,
      reason: "length",
      usage: {
        inputTokens: {
          uncached: 80,
          total: 100,
          cacheRead: 20,
          cacheWrite: undefined,
        },
        outputTokens: { total: 30, text: 18, reasoning: 12 },
      },
    });
  });

  it("normalizes provider errors into JSON-safe trace events", () => {
    expect(
      traceResponsePart({
        step: 3,
        part: part("error", { error: new Error("provider failed") }),
      })
    ).toEqual({
      type: "provider-error",
      step: 3,
      error: "provider failed",
    });
  });
});

describe("finishReasonFailure", () => {
  it("accepts normal and tool-call finishes", () => {
    expect(finishReasonFailure("stop")).toBeUndefined();
    expect(finishReasonFailure("tool-calls")).toBeUndefined();
  });

  it("turns a token-limit finish into an incomplete-turn failure", () => {
    expect(finishReasonFailure("length")).toEqual(
      new Error("The model stopped because it reached its token limit.")
    );
  });
});

describe("summarizeAgentTrace", () => {
  it("adds usage and trajectory counts without retaining payloads", () => {
    const events: AgentTraceEvent[] = [
      { type: "model-step-start", step: 1 },
      {
        type: "tool-call",
        step: 1,
        id: "call-1",
        name: "list_references",
        input: { nodeId: "notify" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "call-1",
        name: "list_references",
        result: { references: ["{{event.payload.customer.id}}"] },
        failed: true,
      },
      {
        type: "model-step-finish",
        step: 1,
        reason: "stop",
        usage: {
          inputTokens: { total: 100, cacheRead: 20 },
          outputTokens: { total: 30, reasoning: 12 },
        },
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "call-2",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ];

    expect(summarizeAgentTrace(events)).toEqual({
      modelCalls: 1,
      toolCalls: 1,
      refusals: 1,
      graphRevisions: 1,
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 130,
      finishReason: "stop",
      finishReasons: ["stop"],
    });
  });
});
