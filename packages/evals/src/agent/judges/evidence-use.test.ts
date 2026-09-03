import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import { assessEvidenceUse } from "#src/agent/judges/evidence-use";

function call(
  id: string,
  name: string,
  input: JsonObject = {}
): AgentTraceEvent {
  return { type: "tool-call", step: 1, id, name, input };
}

function result(id: string, name: string, failed = false): AgentTraceEvent {
  return { type: "tool-result", step: 1, id, name, result: {}, failed };
}

function valueResult(
  id: string,
  name: string,
  value: Extract<AgentTraceEvent, { type: "tool-result" }>["result"]
): AgentTraceEvent {
  return {
    type: "tool-result",
    step: 1,
    id,
    name,
    result: value,
    failed: false,
  };
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

  it("requires action evidence before inserting a node", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("insert", "insert_node_on_edge", { actionId: "Wait" }),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale:
        "Wait was inserted before a successful describe_action result.",
    });
  });

  it("requires detailed Event evidence before configuring it", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("write", "set_lifecycle_rules", {
        startEvents: ["applicant.created"],
      }),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale:
        "applicant.created was used before a successful describe_event result.",
    });
  });

  it("requires all capability discovery before the first graph write", () => {
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("lifecycle", "set_lifecycle_rules"),
      call("describe", "describe_action", { actionId: "score-applicant" }),
      result("describe", "describe_action"),
      call("add", "add_node", { actionId: "score-applicant" }),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale:
        "score-applicant was added before capability discovery finished.",
    });
  });

  it("requires the exact referenced token in prior discovery output", () => {
    const token = "{{@entry:Lifecycle.applicantId}}";
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("references", "list_references", { nodeId: "score" }),
      valueResult("references", "list_references", {
        references: [
          {
            token: "{{@entry:Lifecycle.email}}",
            sourceNodeId: "entry",
            sourceNodeLabel: "Lifecycle",
            path: "email",
          },
        ],
      }),
      call("update", "update_node", {
        nodeId: "score",
        config: [{ key: "applicantId", value: token }],
      }),
    ]);

    expect(assessEvidenceUse(trajectory)).toEqual({
      score: 0,
      rationale: `${token} was used before list_references returned that exact token for score.`,
    });
  });

  it("accepts exact action, Event, and reference evidence", () => {
    const token = "{{@entry:Lifecycle.applicantId}}";
    const trajectory = buildAgentTrajectory([
      call("read", "read_workflow"),
      result("read", "read_workflow"),
      call("event", "describe_event", { eventName: "applicant.created" }),
      result("event", "describe_event"),
      call("describe", "describe_action", { actionId: "score-applicant" }),
      result("describe", "describe_action"),
      call("lifecycle", "set_lifecycle_rules", {
        startEvents: ["applicant.created"],
      }),
      call("insert", "insert_node_on_edge", {
        actionId: "score-applicant",
      }),
      call("references", "list_references", { nodeId: "score" }),
      valueResult("references", "list_references", {
        references: [
          {
            token,
            sourceNodeId: "entry",
            sourceNodeLabel: "Lifecycle",
            path: "applicantId",
          },
        ],
      }),
      call("update", "update_node", {
        nodeId: "score",
        config: [{ key: "applicantId", value: token }],
      }),
    ]);

    expect(assessEvidenceUse(trajectory)).toMatchObject({ score: 1 });
  });
});
