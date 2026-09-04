import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import type { CompletionFacts } from "#src/agent/completion-facts";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import { assessRecovery } from "#src/agent/judges/recovery";

const completedFacts: CompletionFacts = {
  graphStatus: "ready",
  responseStatus: "answered",
  turnStatus: "completed",
  structuralIssues: [],
  publishBlockers: [],
  warnings: [],
  finalFinishReason: "stop",
};

function successfulWrite(input: {
  id: string;
  step: number;
  revision: number;
}): AgentTraceEvent[] {
  return [
    {
      type: "tool-call",
      step: input.step,
      id: input.id,
      name: "add_node",
      input: {},
    },
    {
      type: "tool-result",
      step: input.step,
      id: input.id,
      name: "add_node",
      result: {},
      failed: false,
      graphRevision: input.revision,
    },
    {
      type: "graph-revision",
      step: input.step,
      toolCallId: input.id,
      revision: input.revision,
      document: { nodes: [], edges: [] },
    },
  ];
}

describe("assessRecovery", () => {
  it("accepts distinct refusals followed by a completed answer", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first",
        name: "connect_nodes",
        input: { source: "one", target: "two" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "first",
        name: "connect_nodes",
        result: { reason: "invalid" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 2,
        id: "read-after-first",
        name: "read_workflow",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "read-after-first",
        name: "read_workflow",
        result: { nodes: [], edges: [] },
        failed: false,
      },
      {
        type: "tool-call",
        step: 3,
        id: "second",
        name: "connect_nodes",
        input: { source: "three", target: "four" },
      },
      {
        type: "tool-result",
        step: 3,
        id: "second",
        name: "connect_nodes",
        result: { reason: "invalid" },
        failed: true,
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 1,
      }
    );
  });

  it("rejects a stream or turn failure", () => {
    expect(
      assessRecovery({
        facts: { ...completedFacts, turnStatus: "failed" },
        trajectory: buildAgentTrajectory([]),
      })
    ).toMatchObject({ score: 0, rationale: expect.stringContaining("failed") });
  });

  it("rejects a provider error even when a later finish reports completion", () => {
    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: buildAgentTrajectory([
          { type: "provider-error", step: 1, error: "provider failed" },
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("provider"),
    });
  });

  it("rejects a missing final answer", () => {
    expect(
      assessRecovery({
        facts: { ...completedFacts, responseStatus: "missing" },
        trajectory: buildAgentTrajectory([]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("final answer"),
    });
  });

  it("rejects unresolved calls", () => {
    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: buildAgentTrajectory([
          {
            type: "tool-call",
            step: 1,
            id: "pending",
            name: "validate_workflow",
            input: {},
          },
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("unresolved"),
    });
  });

  it("rejects unmatched tool results", () => {
    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: buildAgentTrajectory([
          {
            type: "tool-result",
            step: 1,
            id: "missing",
            name: "read_workflow",
            result: {},
            failed: false,
          },
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("unmatched"),
    });
  });

  it("rejects an unmatched graph revision", () => {
    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: buildAgentTrajectory([
          {
            type: "graph-revision",
            step: 1,
            toolCallId: "missing",
            revision: 1,
            document: { nodes: [], edges: [] },
          },
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("graph revision"),
    });
  });

  it("rejects a graph revision with the canonical unmatched status", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "write",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "write",
        name: "add_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: {
          ...trajectory,
          graphRevisions: [
            {
              order: 2,
              step: 1,
              toolCallId: "write",
              matchStatus: "unmatched",
              revision: 1,
              document: { nodes: [], edges: [] },
            },
          ],
        },
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("graph revision"),
    });
  });

  it("rejects a successful write with a missing graph-revision event", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "write",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "write",
        name: "add_node",
        result: { nodeId: "notify" },
        failed: false,
        graphRevision: 1,
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("missing graph revision"),
      }
    );
  });

  it("rejects a successful write that omits its graph revision", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "write",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "write",
        name: "add_node",
        result: { nodeId: "notify" },
        failed: false,
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("missing graph revision"),
      }
    );
  });

  it("rejects duplicate graph-revision events for a successful write", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "write",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "write",
        name: "add_node",
        result: { nodeId: "notify" },
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("duplicate graph revisions"),
      }
    );
  });

  it("rejects duplicate revision numbers across successful writes", () => {
    const trajectory = buildAgentTrajectory([
      ...successfulWrite({ id: "first", step: 1, revision: 1 }),
      ...successfulWrite({ id: "second", step: 2, revision: 1 }),
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("start at 1 and increase by one"),
      }
    );
  });

  it("rejects skipped revision numbers across successful writes", () => {
    const trajectory = buildAgentTrajectory([
      ...successfulWrite({ id: "first", step: 1, revision: 1 }),
      ...successfulWrite({ id: "second", step: 2, revision: 3 }),
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("start at 1 and increase by one"),
      }
    );
  });

  it("rejects decreasing revision numbers across successful writes", () => {
    const trajectory = buildAgentTrajectory([
      ...successfulWrite({ id: "first", step: 1, revision: 2 }),
      ...successfulWrite({ id: "second", step: 2, revision: 1 }),
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("start at 1 and increase by one"),
      }
    );
  });

  it("rejects revision events that are reordered relative to successful writes", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "first",
        name: "add_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "tool-call",
        step: 2,
        id: "second",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "second",
        name: "add_node",
        result: {},
        failed: false,
        graphRevision: 2,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "second",
        revision: 2,
        document: { nodes: [], edges: [] },
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "first",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining(
          "do not follow successful write result order"
        ),
      }
    );
  });

  it("accepts queued writes from the same model step after a refusal", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first-write",
        name: "update_node",
        input: { id: "notify", label: "First" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "first-write",
        name: "update_node",
        result: { reason: "invalid" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 1,
        id: "queued-write",
        name: "update_node",
        input: { id: "notify", label: "Second" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "queued-write",
        name: "update_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "queued-write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 1,
      }
    );
  });

  it("rejects a write in a later model step after a refusal without a fresh read", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first-write",
        name: "update_node",
        input: { id: "notify", label: "First" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "first-write",
        name: "update_node",
        result: { reason: "invalid" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 2,
        id: "second-write",
        name: "update_node",
        input: { id: "notify", label: "Second" },
      },
      {
        type: "tool-result",
        step: 2,
        id: "second-write",
        name: "update_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "second-write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("fresh read_workflow"),
      }
    );
  });

  it("accepts a write in a later model step after a fresh successful read", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first-write",
        name: "update_node",
        input: { id: "notify", label: "First" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "first-write",
        name: "update_node",
        result: { reason: "invalid" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 2,
        id: "fresh-read",
        name: "read_workflow",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "fresh-read",
        name: "read_workflow",
        result: { nodes: [], edges: [] },
        failed: false,
      },
      {
        type: "tool-call",
        step: 3,
        id: "second-write",
        name: "update_node",
        input: { id: "notify", label: "Second" },
      },
      {
        type: "tool-result",
        step: 3,
        id: "second-write",
        name: "update_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 3,
        toolCallId: "second-write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 1,
      }
    );
  });

  it("does not accept a failed read before a write retry", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "first-write",
        name: "update_node",
        input: { id: "notify", label: "First" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "first-write",
        name: "update_node",
        result: { reason: "invalid" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 2,
        id: "failed-read",
        name: "read_workflow",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "failed-read",
        name: "read_workflow",
        result: { reason: "unavailable" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 3,
        id: "second-write",
        name: "update_node",
        input: { id: "notify", label: "Second" },
      },
      {
        type: "tool-result",
        step: 3,
        id: "second-write",
        name: "update_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 3,
        toolCallId: "second-write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("fresh read_workflow"),
      }
    );
  });

  it("rejects a write after a failed describe_action without a fresh read", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "describe",
        name: "describe_action",
        input: { actionId: "slack/send-message" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "describe",
        name: "describe_action",
        result: { reason: "unavailable" },
        failed: true,
      },
      {
        type: "tool-call",
        step: 2,
        id: "write",
        name: "add_node",
        input: { actionId: "slack/send-message" },
      },
      {
        type: "tool-result",
        step: 2,
        id: "write",
        name: "add_node",
        result: { nodeId: "notify" },
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "write",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(assessRecovery({ facts: completedFacts, trajectory })).toMatchObject(
      {
        score: 0,
        rationale: expect.stringContaining("fresh read_workflow"),
      }
    );
  });

  it("rejects repeated identical refusals", () => {
    const refusal = (id: string) => [
      {
        type: "tool-call" as const,
        step: 1,
        id,
        name: "connect_nodes",
        input: { source: "one", target: "two" },
      },
      {
        type: "tool-result" as const,
        step: 1,
        id,
        name: "connect_nodes",
        result: { reason: "invalid" },
        failed: true,
      },
    ];

    expect(
      assessRecovery({
        facts: completedFacts,
        trajectory: buildAgentTrajectory([
          ...refusal("one"),
          ...refusal("two"),
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("repeated"),
    });
  });
});
