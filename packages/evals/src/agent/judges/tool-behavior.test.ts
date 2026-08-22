import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "vitest-evals";
import {
  assessConfusion,
  assessToolBehavior,
} from "#src/agent/judges/tool-behavior";

describe("assessToolBehavior", () => {
  it("accepts an inspected action followed by editing and validation", () => {
    const events: TranscriptEvent[] = [
      { type: "tool_call", id: "1", name: "read_workflow", arguments: {} },
      { type: "tool_result", toolCallId: "1", name: "read_workflow" },
      {
        type: "tool_call",
        id: "2",
        name: "describe_action",
        arguments: { actionId: "score-applicant" },
      },
      { type: "tool_result", toolCallId: "2", name: "describe_action" },
      {
        type: "tool_call",
        id: "3",
        name: "add_node",
        arguments: { actionId: "score-applicant", label: "Score" },
      },
      { type: "tool_result", toolCallId: "3", name: "add_node" },
      {
        type: "tool_call",
        id: "4",
        name: "validate_workflow",
        arguments: {},
      },
      { type: "tool_result", toolCallId: "4", name: "validate_workflow" },
    ];

    expect(assessToolBehavior(events)).toEqual({
      score: 1,
      rationale: "The tool trace follows the workflow-authoring protocol.",
    });
  });

  it("reports editing before discovery and omitted validation", () => {
    const events: TranscriptEvent[] = [
      {
        type: "tool_call",
        id: "1",
        name: "add_node",
        arguments: { actionId: "score-applicant", label: "Score" },
      },
      { type: "tool_result", toolCallId: "1", name: "add_node" },
    ];

    expect(assessToolBehavior(events)).toEqual({
      score: 0,
      rationale:
        "the graph was edited before read_workflow; score-applicant was added before describe_action; the graph changed after the last validate_workflow call.",
    });
  });

  it("requires built-in steps to be inspected before they are added", () => {
    const events: TranscriptEvent[] = [
      { type: "tool_call", id: "1", name: "read_workflow", arguments: {} },
      { type: "tool_result", toolCallId: "1", name: "read_workflow" },
      {
        type: "tool_call",
        id: "2",
        name: "add_node",
        arguments: { actionId: "Event Split", label: "Split by event" },
      },
      { type: "tool_result", toolCallId: "2", name: "add_node" },
      {
        type: "tool_call",
        id: "3",
        name: "validate_workflow",
        arguments: {},
      },
      { type: "tool_result", toolCallId: "3", name: "validate_workflow" },
    ];

    expect(assessToolBehavior(events)).toEqual({
      score: 0,
      rationale: "Event Split was added before describe_action.",
    });
  });

  it("allows capability discovery without reading a graph that stays unchanged", () => {
    const events: TranscriptEvent[] = [
      {
        type: "tool_call",
        id: "1",
        name: "list_actions",
        arguments: { query: "SMS" },
      },
      { type: "tool_result", toolCallId: "1", name: "list_actions" },
    ];

    expect(assessToolBehavior(events)).toEqual({
      score: 1,
      rationale: "The tool trace follows the workflow-authoring protocol.",
    });
  });
});

describe("assessConfusion", () => {
  it("accepts a completed turn that repaired distinct refusals", () => {
    expect(
      assessConfusion({
        errors: [],
        finalText: "The workflow is ready.",
        toolCalls: [
          {
            name: "connect_nodes",
            status: "error",
            arguments: { source: "a" },
          },
          {
            name: "connect_nodes",
            status: "error",
            arguments: { source: "b" },
          },
          { name: "validate_workflow", status: "success", arguments: {} },
        ],
      })
    ).toEqual({
      score: 1,
      rationale: "The turn recovered from 2 refused tool calls and completed.",
    });
  });

  it("reports a repeated refusal", () => {
    expect(
      assessConfusion({
        errors: [],
        finalText: "I could not complete the workflow.",
        toolCalls: [
          {
            name: "connect_nodes",
            status: "error",
            arguments: { source: "a" },
          },
          {
            name: "connect_nodes",
            status: "error",
            arguments: { source: "a" },
          },
        ],
      })
    ).toEqual({
      score: 0,
      rationale:
        "The turn had 2 refused tool calls and 0 stream errors, including a repeated refusal.",
    });
  });

  it("reports a turn that stopped after refusals without an answer", () => {
    expect(
      assessConfusion({
        errors: [],
        finalText: "",
        toolCalls: [
          {
            name: "connect_nodes",
            status: "error",
            arguments: { source: "a" },
          },
        ],
      })
    ).toEqual({
      score: 0,
      rationale:
        "The turn had 1 refused tool calls and 0 stream errors, then ended without an answer.",
    });
  });

  it("reports an unfinished tool call", () => {
    expect(
      assessConfusion({
        errors: [],
        finalText: "The workflow is ready.",
        toolCalls: [
          { name: "validate_workflow", status: "pending", arguments: {} },
        ],
      })
    ).toEqual({
      score: 0,
      rationale:
        "The turn had 0 refused tool calls and 0 stream errors, with 1 unfinished tool call.",
    });
  });
});
