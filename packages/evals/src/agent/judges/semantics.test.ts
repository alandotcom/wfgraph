import { describe, expect, it } from "vitest";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";

const initialDocument: AgentEvalDocument = {
  nodes: [],
  edges: [],
};

const input: AgentEvalInput = {
  messages: [{ role: "user", content: "Score each new applicant." }],
  document: initialDocument,
  catalog: { events: [], actions: [], integrations: [] },
  integrations: [],
  expected: {
    requiredActions: { "score-applicant": 1 },
    startEvents: ["applicant.created"],
    requiredFlows: [
      {
        source: { kind: "lifecycle" },
        target: { kind: "action", actionId: "score-applicant" },
        sourceHandle: "started",
      },
    ],
  },
  intentCriteria: ["Each applicant is scored after the start Event."],
};

function completedDocument(): AgentEvalDocument {
  return {
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Lifecycle",
          type: "lifecycle",
          config: {
            lifecycleRules: {
              startEvents: ["applicant.created"],
              cancelEvents: [],
              concurrency: "unlimited",
            },
          },
        },
      },
      {
        id: "score",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score applicant",
          type: "action",
          config: { actionType: "score-applicant" },
        },
      },
    ],
    edges: [
      {
        id: "edge",
        source: "entry",
        target: "score",
        sourceHandle: "started",
      },
    ],
  };
}

describe("assessScenarioSemantics", () => {
  it("accepts a graph that satisfies the scenario constraints", () => {
    expect(assessScenarioSemantics(input, completedDocument())).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("reports missing actions, Events, and flows together", () => {
    expect(assessScenarioSemantics(input, { nodes: [], edges: [] })).toEqual({
      score: 0,
      rationale:
        "Expected 1 score-applicant node, found 0; missing Start Event applicant.created; missing required flow lifecycle -> score-applicant through started.",
    });
  });
});
