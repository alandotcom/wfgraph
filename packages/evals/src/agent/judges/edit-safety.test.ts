import { describe, expect, it } from "vitest";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import { assessExpectedCompletion } from "#src/agent/judges/completion";
import { assessEditSafety } from "#src/agent/judges/edit-safety";

const readyFacts = {
  graphStatus: "ready" as const,
  responseStatus: "answered" as const,
  turnStatus: "completed" as const,
  structuralIssues: [],
  publishBlockers: [],
  warnings: [],
  finalFinishReason: "stop",
};

const protectedDocument: AgentDocument = {
  nodes: [
    {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle" },
    },
    {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify",
        type: "action",
        config: { actionType: "slack/send-message", channel: "#ops" },
      },
    },
  ],
  edges: [
    {
      id: "lifecycle-notify",
      source: "lifecycle",
      target: "notify",
      sourceHandle: "started",
    },
  ],
};

function writeRevision(document: AgentDocument): AgentTraceEvent[] {
  return [
    { type: "tool-call", step: 1, id: "write", name: "update_node", input: {} },
    {
      type: "tool-result",
      step: 1,
      id: "write",
      name: "update_node",
      result: {},
      failed: false,
      graphRevision: 1,
    },
    {
      type: "graph-revision",
      step: 1,
      toolCallId: "write",
      revision: 1,
      document,
    },
  ];
}

describe("assessEditSafety", () => {
  it("accepts revisions that retain protected nodes and edges exactly", () => {
    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: {
          protectedNodeIds: ["notify"],
          protectedEdgeIds: ["lifecycle-notify"],
        },
        trajectory: buildAgentTrajectory(writeRevision(protectedDocument)),
      })
    ).toMatchObject({ score: 1 });
  });

  it("compares protected records in their JSON representation", () => {
    const documentWithClearedConfig: AgentDocument = {
      ...protectedDocument,
      nodes: protectedDocument.nodes.map((node) =>
        node.id === "notify"
          ? {
              ...node,
              data: {
                ...node.data,
                config: { ...node.data.config, clearedValue: undefined },
              },
            }
          : node
      ),
    };

    expect(
      assessEditSafety({
        document: documentWithClearedConfig,
        expected: { protectedNodeIds: ["notify"] },
        trajectory: buildAgentTrajectory(
          writeRevision(documentWithClearedConfig)
        ),
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects an intermediate protected-node change even when a later revision repairs it", () => {
    const damaged: AgentDocument = {
      ...protectedDocument,
      nodes: protectedDocument.nodes.map((node) =>
        node.id === "notify"
          ? { ...node, data: { ...node.data, label: "Changed" } }
          : node
      ),
    };
    const repaired = writeRevision(protectedDocument).map((event) =>
      event.type === "tool-call" || event.type === "tool-result"
        ? { ...event, id: `${event.id}-2` }
        : event.type === "graph-revision"
          ? { ...event, toolCallId: `${event.toolCallId}-2`, revision: 2 }
          : event
    );

    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { protectedNodeIds: ["notify"] },
        trajectory: buildAgentTrajectory([
          ...writeRevision(damaged),
          ...repaired,
        ]),
      })
    ).toMatchObject({ score: 0, rationale: expect.stringContaining("notify") });
  });

  it("rejects a revision that omits a protected edge", () => {
    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { protectedEdgeIds: ["lifecycle-notify"] },
        trajectory: buildAgentTrajectory(
          writeRevision({ ...protectedDocument, edges: [] })
        ),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("lifecycle-notify"),
    });
  });

  it("ignores a revision whose id and number belong to a write from another step", () => {
    const changedDocument: AgentDocument = {
      ...protectedDocument,
      nodes: protectedDocument.nodes.map((node) =>
        node.id === "notify"
          ? { ...node, data: { ...node.data, label: "Changed" } }
          : node
      ),
    };

    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { protectedNodeIds: ["notify"] },
        trajectory: buildAgentTrajectory([
          ...writeRevision(protectedDocument),
          {
            type: "tool-call",
            step: 2,
            id: "write",
            name: "update_node",
            input: {},
          },
          {
            type: "graph-revision",
            step: 2,
            toolCallId: "write",
            revision: 1,
            document: changedDocument,
          },
        ]),
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects a forbidden write attempt even when the handler refuses it", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "delete",
        name: "delete_node",
        input: { nodeId: "notify" },
      },
      {
        type: "tool-result",
        step: 1,
        id: "delete",
        name: "delete_node",
        result: { reason: "protected" },
        failed: true,
      },
    ]);

    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { forbiddenMutations: ["delete_node"] },
        trajectory,
      })
    ).toEqual({
      score: 0,
      rationale:
        "delete_node was attempted although the mutation is forbidden.",
    });
  });

  it("rejects every write when forbiddenMutations is all", () => {
    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { forbiddenMutations: "all" },
        trajectory: buildAgentTrajectory([
          {
            type: "tool-call",
            step: 1,
            id: "update",
            name: "update_node",
            input: { nodeId: "notify" },
          },
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("update_node"),
    });
  });

  it("leaves clarification graph mutation rejection to EditSafety", () => {
    const trajectory = buildAgentTrajectory(writeRevision(protectedDocument));

    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "clarification",
          questionMustMention: ["channel"],
        },
        finalText: "Which channel should receive the notification?",
        facts: readyFacts,
      })
    ).toMatchObject({ score: 1 });
    expect(
      assessEditSafety({
        document: protectedDocument,
        expected: { forbiddenMutations: "all" },
        trajectory,
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("update_node"),
    });
  });
});
