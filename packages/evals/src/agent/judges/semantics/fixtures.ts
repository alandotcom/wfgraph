import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";

const initialDocument: AgentEvalDocument = {
  nodes: [],
  edges: [],
};

export const input: AgentEvalInput = {
  messages: [{ role: "user", content: "Score each new applicant." }],
  document: initialDocument,
  catalog: { events: [], actions: [], integrations: [] },
  integrations: [],
  expected: {
    exactActions: { "score-applicant": 1 },
    exactEvents: { start: ["applicant.created"], cancel: [] },
    requiredFlows: [
      {
        source: { kind: "lifecycle" },
        target: { kind: "action", actionId: "score-applicant" },
        sourceHandle: "started",
      },
    ],
  },
  expectedCompletion: { outcome: "ready" },
  intentCriteria: ["Each applicant is scored after the start Event."],
};

export function completedDocument(): AgentEvalDocument {
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
