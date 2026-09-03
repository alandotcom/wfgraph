import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import { assessEvidenceUse } from "#src/agent/judges/evidence-use";

function call(
  id: string,
  name: string,
  input: Record<string, string> = {}
): AgentTraceEvent {
  return { type: "tool-call", step: 1, id, name, input };
}

function result(id: string, name: string, failed = false): AgentTraceEvent {
  return { type: "tool-result", step: 1, id, name, result: {}, failed };
}

describe("assessEvidenceUse", () => {
  it("accepts successful workflow and action evidence before a write", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("describe", "describe_action", { actionId: "slack/send-message" }),
      result("describe", "describe_action"),
      call("add", "add_node", { actionId: "slack/send-message" }),
    ]);

    expect(assessEvidenceUse(trajectory)).toMatchObject({ score: 1 });
  });

  it("rejects a write after a failed workflow read", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow", true),
      call("write", "set_lifecycle_rules"),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale:
        "set_lifecycle_rules was called before a successful read_workflow result.",
    });
  });

  it("rejects add_node after a failed description for the same action", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("describe", "describe_action", { actionId: "slack/send-message" }),
      result("describe", "describe_action", true),
      call("add", "add_node", { actionId: "slack/send-message" }),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale:
        "slack/send-message was added before a successful describe_action result.",
    });
  });
});
