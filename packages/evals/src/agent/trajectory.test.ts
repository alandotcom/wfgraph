import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import {
  buildAgentTrajectory,
  selectGraphRevisionWrites,
  selectSuccessfulGraphRevisions,
  selectUnmatchedGraphRevisions,
  selectUnresolvedCalls,
} from "#src/agent/trajectory";

describe("buildAgentTrajectory", () => {
  it("pairs calls with results, graph revisions, finishes, and provider errors", () => {
    const events: AgentTraceEvent[] = [
      { type: "model-step-start", step: 1 },
      {
        type: "tool-call",
        step: 1,
        id: "read-1",
        name: "read_workflow",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "read-1",
        name: "read_workflow",
        result: { nodes: [], edges: [] },
        failed: false,
      },
      {
        type: "tool-call",
        step: 2,
        id: "write-1",
        name: "add_node",
        input: { actionId: "slack/send-message" },
      },
      {
        type: "tool-result",
        step: 2,
        id: "write-1",
        name: "add_node",
        result: { nodeId: "notify" },
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "write-1",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
      {
        type: "tool-call",
        step: 3,
        id: "pending-1",
        name: "validate_workflow",
        input: {},
      },
      {
        type: "model-step-finish",
        step: 3,
        reason: "stop",
        usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } },
      },
      { type: "provider-error", step: 3, error: "late provider error" },
    ];

    const trajectory = buildAgentTrajectory(events);

    expect(trajectory.calls).toMatchObject([
      {
        id: "read-1",
        order: 1,
        result: { result: { nodes: [], edges: [] }, failed: false },
      },
      {
        id: "write-1",
        order: 3,
        result: { graphRevision: 1 },
      },
      { id: "pending-1", order: 6 },
    ]);
    expect(trajectory.graphRevisions).toEqual([
      {
        order: 5,
        step: 2,
        toolCallId: "write-1",
        matchStatus: "matched",
        toolCallOrder: 3,
        toolResultOrder: 4,
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);
    expect(trajectory.modelFinishes).toHaveLength(1);
    expect(trajectory.calls[1]).not.toHaveProperty("graphRevision");
    expect(trajectory.providerErrors).toEqual([
      { order: 8, step: 3, error: "late provider error" },
    ]);
    expect(selectUnresolvedCalls(trajectory)).toEqual([
      expect.objectContaining({ id: "pending-1" }),
    ]);
    expect(trajectory).not.toHaveProperty("unresolvedCalls");
    expect(trajectory).not.toHaveProperty("successfulGraphRevisions");
    expect(trajectory).not.toHaveProperty("unmatchedGraphRevisions");
    expect(trajectory.graphRevisionSequence).toEqual({
      status: "valid",
      issues: [],
    });
    expect(JSON.parse(JSON.stringify(trajectory))).toEqual(trajectory);
  });

  it("retains a result whose call is absent from the trace", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-result",
        step: 1,
        id: "missing-call",
        name: "read_workflow",
        result: {},
        failed: true,
      },
    ]);

    expect(trajectory.unmatchedResults).toEqual([
      expect.objectContaining({ id: "missing-call", failed: true }),
    ]);
  });

  it("does not pair a result that precedes its matching call", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-result",
        step: 1,
        id: "out-of-order",
        name: "read_workflow",
        result: {},
        failed: false,
      },
      {
        type: "tool-call",
        step: 1,
        id: "out-of-order",
        name: "read_workflow",
        input: {},
      },
    ]);

    expect(trajectory.unmatchedResults).toEqual([
      expect.objectContaining({ id: "out-of-order" }),
    ]);
    expect(selectUnresolvedCalls(trajectory)).toEqual([
      expect.objectContaining({ id: "out-of-order" }),
    ]);
  });

  it("pairs repeated ids by step, name, and event order", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "reused-id",
        name: "add_node",
        result: { nodeId: "first" },
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "reused-id",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
      {
        type: "tool-call",
        step: 2,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "reused-id",
        name: "update_node",
        result: { nodeId: "wrong-name" },
        failed: false,
      },
      {
        type: "tool-result",
        step: 2,
        id: "reused-id",
        name: "add_node",
        result: { nodeId: "second" },
        failed: false,
        graphRevision: 2,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "reused-id",
        revision: 2,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(trajectory.calls).toMatchObject([
      {
        step: 1,
        id: "reused-id",
        result: { result: { nodeId: "first" }, graphRevision: 1 },
      },
      {
        step: 2,
        id: "reused-id",
        result: { result: { nodeId: "second" }, graphRevision: 2 },
      },
    ]);
    expect(trajectory.unmatchedResults).toEqual([
      expect.objectContaining({ step: 2, name: "update_node" }),
    ]);
    expect(trajectory.graphRevisions).toMatchObject([
      {
        step: 1,
        toolCallId: "reused-id",
        matchStatus: "matched",
        toolCallOrder: 0,
      },
      {
        step: 2,
        toolCallId: "reused-id",
        matchStatus: "matched",
        toolCallOrder: 3,
      },
    ]);
    expect(selectSuccessfulGraphRevisions(trajectory)).toEqual(
      trajectory.graphRevisions
    );
    expect(selectUnmatchedGraphRevisions(trajectory)).toEqual([]);
  });

  it("links duplicate ids across steps to the successful result in each step", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "reused-id",
        name: "add_node",
        result: { nodeId: "first" },
        failed: false,
        graphRevision: 1,
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "reused-id",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
      {
        type: "tool-call",
        step: 2,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 2,
        id: "reused-id",
        name: "add_node",
        result: { nodeId: "second" },
        failed: false,
        graphRevision: 2,
      },
      {
        type: "graph-revision",
        step: 2,
        toolCallId: "reused-id",
        revision: 2,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(trajectory.graphRevisions).toEqual([
      expect.objectContaining({
        step: 1,
        toolCallId: "reused-id",
        revision: 1,
        matchStatus: "matched",
        toolCallOrder: 0,
      }),
      expect.objectContaining({
        step: 2,
        toolCallId: "reused-id",
        revision: 2,
        matchStatus: "matched",
        toolCallOrder: 3,
      }),
    ]);
  });

  it("uses null for a graph revision with no earlier successful result", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "missing-call",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
    ]);

    expect(trajectory.graphRevisions).toEqual([
      expect.objectContaining({
        matchStatus: "unmatched",
      }),
    ]);
    expect(selectSuccessfulGraphRevisions(trajectory)).toEqual([]);
    expect(selectUnmatchedGraphRevisions(trajectory)).toEqual(
      trajectory.graphRevisions
    );
    expect(JSON.parse(JSON.stringify(trajectory))).toEqual(trajectory);
  });

  it("records a missing graph-revision event for a successful write result", () => {
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

    expect(trajectory.graphRevisionWrites).toEqual([
      {
        step: 1,
        toolCallId: "write",
        toolCallOrder: 0,
        toolResultOrder: 1,
        revision: 1,
        matchStatus: "missing",
        graphRevisionOrders: [],
      },
    ]);
    expect(selectSuccessfulGraphRevisions(trajectory)).toEqual([]);
  });

  it("records a successful write that omits its graph revision as missing", () => {
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

    expect(selectGraphRevisionWrites(trajectory)).toEqual([
      {
        step: 1,
        toolCallId: "write",
        toolCallOrder: 0,
        toolResultOrder: 1,
        matchStatus: "missing",
        graphRevisionOrders: [],
      },
    ]);
  });

  it("records duplicate graph-revision events for one successful write result", () => {
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

    expect(trajectory.graphRevisionWrites).toEqual([
      {
        step: 1,
        toolCallId: "write",
        toolCallOrder: 0,
        toolResultOrder: 1,
        revision: 1,
        matchStatus: "duplicate",
        graphRevisionOrders: [2, 3],
      },
    ]);
    expect(trajectory.graphRevisions).toEqual([
      expect.objectContaining({
        order: 2,
        matchStatus: "matched",
        toolResultOrder: 1,
      }),
      expect.objectContaining({
        order: 3,
        matchStatus: "matched",
        toolResultOrder: 1,
      }),
    ]);
    expect(selectSuccessfulGraphRevisions(trajectory)).toEqual([]);
  });

  it("records invalid revision sequence evidence for duplicate, skipped, decreasing, and reordered revisions", () => {
    const cases: Array<{
      name: string;
      events: AgentTraceEvent[];
      issue: string;
    }> = [
      {
        name: "duplicate revisions across writes",
        events: [
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
            type: "graph-revision",
            step: 1,
            toolCallId: "first",
            revision: 1,
            document: { nodes: [], edges: [] },
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
            graphRevision: 1,
          },
          {
            type: "graph-revision",
            step: 2,
            toolCallId: "second",
            revision: 1,
            document: { nodes: [], edges: [] },
          },
        ],
        issue: "revisions-not-sequential",
      },
      {
        name: "skipped revision",
        events: [
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
            type: "graph-revision",
            step: 1,
            toolCallId: "first",
            revision: 1,
            document: { nodes: [], edges: [] },
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
            graphRevision: 3,
          },
          {
            type: "graph-revision",
            step: 2,
            toolCallId: "second",
            revision: 3,
            document: { nodes: [], edges: [] },
          },
        ],
        issue: "revisions-not-sequential",
      },
      {
        name: "decreasing revision",
        events: [
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
            graphRevision: 2,
          },
          {
            type: "graph-revision",
            step: 1,
            toolCallId: "first",
            revision: 2,
            document: { nodes: [], edges: [] },
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
            graphRevision: 1,
          },
          {
            type: "graph-revision",
            step: 2,
            toolCallId: "second",
            revision: 1,
            document: { nodes: [], edges: [] },
          },
        ],
        issue: "revisions-not-sequential",
      },
      {
        name: "reordered revision events",
        events: [
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
        ],
        issue: "events-out-of-write-order",
      },
    ];

    for (const testCase of cases) {
      const trajectory = buildAgentTrajectory(testCase.events);

      expect(trajectory.graphRevisionSequence, testCase.name).toEqual({
        status: "invalid",
        issues: [testCase.issue],
      });
    }
  });

  it("drops undefined trace fields while retaining a serializable finish", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "model-step-finish",
        step: 1,
        reason: "stop",
        usage: {
          inputTokens: { total: 2, cacheWrite: undefined },
          outputTokens: { total: 1, reasoning: undefined },
        },
      },
    ]);

    expect(trajectory.modelFinishes).toEqual([
      {
        order: 0,
        step: 1,
        reason: "stop",
        usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } },
      },
    ]);
  });
});
