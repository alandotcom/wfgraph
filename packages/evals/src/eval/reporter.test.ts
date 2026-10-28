import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { formatEvalCase } from "#src/eval/reporter";
import type { EvalCaseRecord } from "#src/eval/types";

const record: EvalCaseRecord = {
  harness: "workflow-build-agent",
  durationMs: 12_340,
  scores: [
    {
      judge: "GroundedGraphJudge",
      gating: true,
      score: 1,
      rationale: "Every node is grounded.",
    },
    {
      judge: "ValidationJudge",
      gating: true,
      score: 0,
      rationale: "The draft has a disconnected node.",
    },
    {
      judge: "EfficiencyBudgetJudge",
      gating: false,
      score: 1,
      rationale: "No budget.",
    },
  ],
  output: null,
  events: [
    { type: "message", role: "user", content: "Build it" },
    { type: "tool_call", id: "1", name: "add_node", arguments: {} },
    { type: "tool_result", toolCallId: "1", name: "add_node", content: {} },
    { type: "tool_call", id: "2", name: "add_node", arguments: {} },
    { type: "tool_result", toolCallId: "2", name: "add_node", content: {} },
    { type: "tool_call", id: "3", name: "connect", arguments: {} },
    {
      type: "tool_result",
      toolCallId: "3",
      name: "connect",
      error: { message: "No such node.", type: "tool_refusal" },
    },
    { type: "message", role: "assistant", content: "Done.\nTwo nodes." },
  ],
  usage: {
    provider: "openai",
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 125,
    toolCalls: 3,
    metadata: {},
  },
  errors: ["stream closed early"],
  artifacts: {},
};

describe("formatEvalCase", () => {
  it("prints scores, rationale below 1, usage, tools, errors and the reply", () => {
    const lines = formatEvalCase({
      name: "suite > builds it",
      state: "failed",
      record,
    }).map((line) => stripVTControlCharacters(line));

    expect(lines).toEqual([
      "✗ suite > builds it 12.3s",
      "  openai/gpt-test: 125 tokens (100 in, 20 out, 5 reasoning), 3 tool calls",
      "  1.00 GroundedGraphJudge",
      "  0.00 ValidationJudge",
      "       The draft has a disconnected node.",
      "  1.00 EfficiencyBudgetJudge (advisory)",
      "  tools: add_node ×2, connect (refused)",
      "  error: stream closed early",
      "  reply: Done.\n         Two nodes.",
    ]);
  });

  it("prints a harness failure with neither usage nor scores", () => {
    const lines = formatEvalCase({
      name: "suite > crashes",
      state: "failed",
      record: {
        harness: "workflow-build-agent",
        durationMs: 500,
        scores: [],
        events: [],
        errors: ["harness exploded"],
        artifacts: {},
      },
    }).map((line) => stripVTControlCharacters(line));

    expect(lines).toEqual([
      "✗ suite > crashes 0.5s",
      "  error: harness exploded",
    ]);
  });
});
