import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "vitest-evals";
import { assessToolBehavior } from "#src/agent/judges/tool-behavior";

describe("assessToolBehavior", () => {
  it("accepts grounded discovery followed by editing and validation", () => {
    const events: TranscriptEvent[] = [
      { type: "tool_call", id: "1", name: "read_workflow", arguments: {} },
      { type: "tool_result", toolCallId: "1", name: "read_workflow" },
      {
        type: "tool_call",
        id: "2",
        name: "list_actions",
        arguments: { query: "score" },
      },
      { type: "tool_result", toolCallId: "2", name: "list_actions" },
      {
        type: "tool_call",
        id: "3",
        name: "describe_action",
        arguments: { actionId: "score-applicant" },
      },
      { type: "tool_result", toolCallId: "3", name: "describe_action" },
      {
        type: "tool_call",
        id: "4",
        name: "add_node",
        arguments: { actionId: "score-applicant", label: "Score" },
      },
      { type: "tool_result", toolCallId: "4", name: "add_node" },
      {
        type: "tool_call",
        id: "5",
        name: "validate_workflow",
        arguments: {},
      },
      { type: "tool_result", toolCallId: "5", name: "validate_workflow" },
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
        "The first tool was add_node, not read_workflow; score-applicant was added before list_actions and describe_action; the graph changed after the last validate_workflow call.",
    });
  });
});
